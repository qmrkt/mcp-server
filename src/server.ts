/**
 * question.market MCP Server Factory
 *
 * Creates an isolated MCP server instance with its own session state.
 * Each call to createQuestionMarketServer() returns a fresh server
 * with independent wallet session, algod/kmd clients, and config.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import algosdk from "algosdk";
import {
  text,
  safe,
  getMnemonicAccount,
  generateWallet,
  compileCreateMarketBlueprint,
} from "./helpers.js";
import { MCP_SERVER_VERSION } from "./version.js";
import { IndexerClient } from "@questionmarket/sdk/indexer";
import { IpfsClient } from "@questionmarket/sdk/ipfs";

import {
  AtomicCreateUnsupportedError,
  MAX_ACTIVE_LP_OUTCOMES,
  createMarketAtomic,
} from "@questionmarket/sdk/clients/market-factory";
import {
  buy,
  claimLpFees,
  claimLpResidual,
  collectLpFees,
  sell,
  getMarketState,
  enterActiveLpForDeposit,
  claim,
  refund,
} from "@questionmarket/sdk/clients/question-market";
import type { ClientConfig } from "@questionmarket/sdk/clients/base";
import {
  quoteBuyForBudgetFromState,
  quoteBuyForSharesFromState,
} from "@questionmarket/sdk";
import {
  CURRENT_MARKET_CONTRACT_VERSION,
  DEFAULT_LP_ENTRY_MAX_PRICE_FP,
  MIN_VISIBLE_MARKET_CONTRACT_VERSION,
  isVisibleMarketVersion,
  marketStatusName,
  normalizeIndexerMarket,
  type NormalizedIndexerMarket,
} from "@questionmarket/sdk/clients/market-schema";

// ---------------------------------------------------------------------------
// Config type
// ---------------------------------------------------------------------------

export interface ServerConfig {
  indexerUrl: string;
  indexerAuth: string;
  indexerWriteToken: string;
  algodServer: string;
  algodPort: number;
  algodToken: string;
  kmdServer: string;
  kmdPort: number;
  kmdToken: string;
  factoryAppId: number;
  protocolConfigAppId: number;
  usdcAsaId: number;
  agentMnemonic: string;
  faucetUrl: string;
  pinataJwt: string;
  pinataGateway: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createQuestionMarketServer(config: ServerConfig) {
  const {
    indexerUrl,
    indexerAuth,
    indexerWriteToken,
    algodServer,
    algodPort,
    algodToken,
    kmdServer,
    kmdPort,
    kmdToken,
    factoryAppId,
    protocolConfigAppId,
    usdcAsaId,
    agentMnemonic,
    faucetUrl,
    pinataJwt,
    pinataGateway,
  } = config;

  const algod = new algosdk.Algodv2(algodToken, algodServer, algodPort);
  const kmd = new algosdk.Kmd(kmdToken, kmdServer, kmdPort);
  const textEncoder = new TextEncoder();
  const hasTradingConfig = usdcAsaId > 0;
  const hasCreateMarketConfig = hasTradingConfig && factoryAppId > 0 && protocolConfigAppId > 0;
  const hasImageUploadConfig = pinataJwt.length > 0;

  const indexer = new IndexerClient({ baseUrl: indexerUrl, auth: indexerAuth || undefined });
  const ipfs = pinataJwt
    ? new IpfsClient({ pinataJwt, pinataGateway: pinataGateway || undefined })
    : null;

  // Session state (isolated per server instance)
  let sessionMnemonic: string | null = null;

  // ── Account helpers ──

  async function getKmdAccount(
    index = 0
  ): Promise<{ addr: string; signer: algosdk.TransactionSigner }> {
    const wallets = await kmd.listWallets();
    const dw = wallets.wallets.find(
      (w: any) => w.name === "unencrypted-default-wallet"
    )!;
    const handle = (await kmd.initWalletHandle(dw.id, "")).wallet_handle_token;
    const keys = await kmd.listKeys(handle);
    const addr = keys.addresses[index];
    const sk = await kmd.exportKey(handle, "", addr);
    await kmd.releaseWalletHandle(handle);
    return {
      addr,
      signer: algosdk.makeBasicAccountTransactionSigner({
        addr,
        sk: sk.private_key,
      } as any),
    };
  }

  async function getDefaultKmdTradingAccount(): Promise<{ addr: string; signer: algosdk.TransactionSigner }> {
    const wallets = await kmd.listWallets();
    const dw = wallets.wallets.find(
      (w: any) => w.name === "unencrypted-default-wallet"
    )!;
    const handle = (await kmd.initWalletHandle(dw.id, "")).wallet_handle_token;
    try {
      const keys = await kmd.listKeys(handle);

      let fallback: { addr: string; signer: algosdk.TransactionSigner } | null = null;
      for (const addr of keys.addresses) {
        const sk = (await kmd.exportKey(handle, "", addr)).private_key;
        const account = {
          addr,
          signer: algosdk.makeBasicAccountTransactionSigner({ addr, sk } as any),
        };
        if (!fallback) {
          fallback = account;
        }
        try {
          const assetInfo = await algod.accountAssetInformation(addr, usdcAsaId).do();
          const balance = BigInt(assetInfo.assetHolding?.amount ?? 0);
          if (balance > 0n) {
            return account;
          }
        } catch {
          // Ignore non-opted accounts and keep searching for a usable localnet trader.
        }
      }

      if (fallback) return fallback;
      throw new Error("No localnet KMD accounts are available.");
    } finally {
      await kmd.releaseWalletHandle(handle);
    }
  }

  function getActiveMnemonic(): string | null {
    return sessionMnemonic || agentMnemonic || null;
  }

  async function getAccount(
    _walletIndex = 0
  ): Promise<{ addr: string; signer: algosdk.TransactionSigner }> {
    const mnemonic = getActiveMnemonic();
    if (mnemonic) return getMnemonicAccount(mnemonic);
    if (_walletIndex === 0) return getDefaultKmdTradingAccount();
    return getKmdAccount(_walletIndex);
  }

  function clientConfig(
    addr: string,
    signer: algosdk.TransactionSigner,
    appId: number
  ): ClientConfig {
    return { algodClient: algod, appId, sender: addr, signer };
  }

  async function ensureFunded(
    account: { addr: string; signer: algosdk.TransactionSigner },
    neededUsdc: bigint
  ) {
    let deployer: { addr: string; signer: algosdk.TransactionSigner };
    try {
      deployer = await getDefaultKmdTradingAccount();
    } catch {
      if (getActiveMnemonic()) return;
      throw new Error("LocalNet deployer wallet is unavailable for auto-funding.");
    }
    if (account.addr === deployer.addr) return;

    const info = await algod.accountInformation(account.addr).do();
    if (BigInt(info.amount ?? 0) < 5_000_000n) {
      const sp = await algod.getTransactionParams().do();
      const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: deployer.addr,
        receiver: account.addr,
        amount: 10_000_000n,
        suggestedParams: sp,
      });
      const atc = new algosdk.AtomicTransactionComposer();
      atc.addTransaction({ txn, signer: deployer.signer });
      await atc.execute(algod, 4);
    }

    try {
      await algod.accountAssetInformation(account.addr, usdcAsaId).do();
    } catch {
      const sp = await algod.getTransactionParams().do();
      const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
        sender: account.addr,
        receiver: account.addr,
        assetIndex: usdcAsaId,
        amount: 0n,
        suggestedParams: sp,
      });
      const atc = new algosdk.AtomicTransactionComposer();
      atc.addTransaction({ txn, signer: account.signer });
      await atc.execute(algod, 4);
    }

    const assetInfo = await algod
      .accountAssetInformation(account.addr, usdcAsaId)
      .do();
    const balance = BigInt(assetInfo.assetHolding?.amount ?? 0);
    if (balance < neededUsdc) {
      const sp = await algod.getTransactionParams().do();
      const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
        sender: deployer.addr,
        receiver: account.addr,
        assetIndex: usdcAsaId,
        amount: neededUsdc * 2n,
        suggestedParams: sp,
      });
      const atc = new algosdk.AtomicTransactionComposer();
      atc.addTransaction({ txn, signer: deployer.signer });
      await atc.execute(algod, 4);
    }
  }

  // ── Helpers ──

  type IndexerPosition = {
    appId: number;
    address: string;
    outcomeIndex: number;
    shares: string;
    costBasis: string;
  };

  type IndexerLpStake = {
    appId: number;
    address: string;
    shares: string;
    feeSnapshot: string;
    claimableFees: string;
  };

  type IndexerMarket = Record<string, unknown>;

  const MICRO_UNITS = 1_000_000;
  const UNSUPPORTED_CONTRACT_VERSION_PREFIX = "Unsupported market version:";

  function assertMarketStatus(appId: number, status: number, allowed: number[], action: string): void {
    if (!allowed.includes(status)) {
      const label = marketStatusName(status);
      const allowedLabels = allowed.map((s) => marketStatusName(s)).join(", ");
      throw new Error(`Cannot ${action}: market ${appId} is ${label}. Required: ${allowedLabels}.`);
    }
  }

  function toMicroUnits(value: number): bigint {
    return BigInt(Math.floor(value * MICRO_UNITS));
  }

  function sharesFromCount(value: number): bigint {
    if (!Number.isInteger(value)) {
      throw new Error("Only whole shares are supported in the current market line.");
    }
    return BigInt(Math.floor(value * MICRO_UNITS));
  }

  function getContractVersion(market: { contractVersion?: number | string | bigint }): number {
    return Number(market.contractVersion ?? CURRENT_MARKET_CONTRACT_VERSION);
  }

  function unsupportedContractVersionError(appId: number, version: number, toolName: string): Error {
    return new Error(
      `${UNSUPPORTED_CONTRACT_VERSION_PREFIX} Market ${appId} uses contract version ${version}. ${toolName} supports version ${MIN_VISIBLE_MARKET_CONTRACT_VERSION}+ markets only.`
    );
  }

  function isUnsupportedContractVersionError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? "");
    return message.startsWith(UNSUPPORTED_CONTRACT_VERSION_PREFIX);
  }

  function isTransientMissingApplicationError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? "");
    return /application \(\d+\) that does not exist/i.test(message);
  }

  async function createMarketAtomicWithRetry(
    config: ClientConfig,
    params: Parameters<typeof createMarketAtomic>[1],
  ): Promise<Awaited<ReturnType<typeof createMarketAtomic>>> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await createMarketAtomic(config, params);
      } catch (error) {
        if (error instanceof AtomicCreateUnsupportedError) {
          throw error;
        }
        lastError = error;
        if (!isTransientMissingApplicationError(error) || attempt === 1) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "atomic create failed"));
  }

  async function getIndexedMarket(appId: number): Promise<NormalizedIndexerMarket> {
    const raw = (await indexer.getMarket(appId)) as any;
    // Frontend proxy wraps in {market: ...}, raw indexer returns bare object
    return normalizeIndexerMarket(raw.market ?? raw);
  }

  async function assertSupportedIndexedMarket(appId: number, toolName: string): Promise<NormalizedIndexerMarket> {
    const market = await getIndexedMarket(appId);
    const contractVersion = getContractVersion(market);
    if (!isVisibleMarketVersion(market)) {
      throw unsupportedContractVersionError(appId, contractVersion, toolName);
    }
    return market;
  }

  function assertSupportedStateVersion(appId: number, contractVersion: number, toolName: string): void {
    if (contractVersion < MIN_VISIBLE_MARKET_CONTRACT_VERSION) {
      throw unsupportedContractVersionError(appId, contractVersion, toolName);
    }
  }

  async function assertSupportedMarket(appId: number, toolName: string): Promise<void> {
    try {
      await assertSupportedIndexedMarket(appId, toolName);
    } catch (error) {
      if (isUnsupportedContractVersionError(error)) throw error;
      const state = await getMarketState(algod, appId);
      assertSupportedStateVersion(appId, Number(state.contractVersion ?? CURRENT_MARKET_CONTRACT_VERSION), toolName);
    }
  }

  function filterSupportedMarketPayload(payload: unknown): unknown {
    if (Array.isArray(payload)) {
      return payload
        .filter((entry) => entry && typeof entry === "object")
        .map((entry) => normalizeIndexerMarket(entry))
        .filter((entry) => isVisibleMarketVersion(entry));
    }

    if (payload && typeof payload === "object" && Array.isArray((payload as { markets?: unknown[] }).markets)) {
      const filteredMarkets = (payload as { markets: unknown[] }).markets.filter(
        (entry) => entry && typeof entry === "object"
      ).map((entry) => normalizeIndexerMarket(entry)).filter((entry) => isVisibleMarketVersion(entry));

      return {
        ...(payload as Record<string, unknown>),
        markets: filteredMarkets,
        total: filteredMarkets.length,
      };
    }

    return payload;
  }

  function quoteBuyForState(
    state: Awaited<ReturnType<typeof getMarketState>>,
    outcomeIndex: number,
    maxCostMicroUsdc: bigint,
    requestedShares?: bigint
  ) {
    const quoteState = {
      quantities: [...state.quantities],
      b: state.b,
      lpFeeBps: state.lpFeeBps,
      protocolFeeBps: state.protocolFeeBps,
    };

    return requestedShares !== undefined
      ? quoteBuyForSharesFromState(quoteState, outcomeIndex, requestedShares)
      : quoteBuyForBudgetFromState(quoteState, outcomeIndex, maxCostMicroUsdc);
  }

  function formatPricePct(priceFp: bigint): string {
    return `${(Number(priceFp) / 10_000).toFixed(2)}%`;
  }

  async function getOnChainOutcomeShares(address: string, appId: number, outcomeIndex: number): Promise<bigint> {
    try {
      const boxName = new Uint8Array([
        ...textEncoder.encode("us:"),
        ...algosdk.decodeAddress(address).publicKey,
        ...algosdk.encodeUint64(outcomeIndex),
      ]);
      const box = await algod.getApplicationBoxByName(appId, boxName).do();
      return BigInt(algosdk.decodeUint64(box.value, "bigint"));
    } catch {
      return 0n;
    }
  }

  async function getCurrentHoldings(address: string) {
    const [positionsRaw, lpRaw] = await Promise.all([
      indexer.getUserPositions(address) as Promise<IndexerPosition[]>,
      indexer.getUserLp(address) as Promise<IndexerLpStake[]>,
    ]);

    const positions = (Array.isArray(positionsRaw) ? positionsRaw : []).filter(
      (position) => Number(position.shares || 0) > 0
    );
    const lpStakes = (Array.isArray(lpRaw) ? lpRaw : []).filter(
      (stake) => Number(stake.shares || 0) > 0 || Number(stake.claimableFees || 0) > 0
    );

    const appIds = Array.from(
      new Set(
        [...positions.map((position) => Number(position.appId)), ...lpStakes.map((stake) => Number(stake.appId))].filter(
          (appId) => appId > 0
        )
      )
    );

    if (appIds.length === 0) {
      return {
        address,
        summary: {
          marketCount: 0, traderMarkets: 0, lpMarkets: 0, shareLines: 0,
          totalMarkedValueUsdc: 0, totalCostBasisUsdc: 0, totalUnrealizedPnlUsdc: 0,
          totalClaimableFeesUsdc: 0, claimableMarkets: 0,
        },
        markets: [],
      };
    }

    const marketResults = await Promise.allSettled(
      appIds.map(async (appId) => {
        const raw = (await indexer.getMarket(appId)) as IndexerMarket
        return [appId, normalizeIndexerMarket(raw)] as const
      })
    );

    const marketsByAppId = new Map<number, NormalizedIndexerMarket>();
    let unavailableMarkets = 0;
    let hiddenLegacyMarkets = 0;
    for (const result of marketResults) {
      if (result.status === "fulfilled") {
        const [appId, market] = result.value;
        if (!isVisibleMarketVersion(market)) {
          hiddenLegacyMarkets += 1;
          continue;
        }
        marketsByAppId.set(appId, market);
      } else {
        unavailableMarkets += 1;
      }
    }

    const positionsByAppId = new Map<number, IndexerPosition[]>();
    for (const position of positions) {
      const appId = Number(position.appId);
      if (!positionsByAppId.has(appId)) positionsByAppId.set(appId, []);
      positionsByAppId.get(appId)!.push(position);
    }

    const lpByAppId = new Map<number, IndexerLpStake>();
    for (const stake of lpStakes) {
      lpByAppId.set(Number(stake.appId), stake);
    }

    const markets = appIds
      .map((appId) => {
        const market = marketsByAppId.get(appId);
        if (!market) return null;

        const numOutcomes = market.numOutcomes;
        const labels = market.outcomes;
        const prices = market.prices;
        const marketPositions = (positionsByAppId.get(appId) ?? [])
          .map((position) => {
            const shares = Number(position.shares || 0);
            const costBasisUsdc = Number(position.costBasis || 0) / MICRO_UNITS;
            const price = prices[position.outcomeIndex] ?? 0;
            const markedValueUsdc = (shares * price) / (MICRO_UNITS * MICRO_UNITS);
            return {
              outcomeIndex: Number(position.outcomeIndex),
              outcomeLabel: labels[position.outcomeIndex] ?? `Outcome ${Number(position.outcomeIndex) + 1}`,
              shares,
              sharesDisplay: shares / MICRO_UNITS,
              costBasisUsdc,
              price,
              pricePct: Number(((price / MICRO_UNITS) * 100).toFixed(1)),
              markedValueUsdc,
              unrealizedPnlUsdc: Number((markedValueUsdc - costBasisUsdc).toFixed(6)),
            };
          })
          .sort((left, right) => right.markedValueUsdc - left.markedValueUsdc || left.outcomeIndex - right.outcomeIndex);

        const lpStake = lpByAppId.get(appId);
        const lpShares = Number(lpStake?.shares || 0);
        const claimableFeesUsdc = Number(lpStake?.claimableFees || 0) / MICRO_UNITS;
        const status = market.status;
        const winningOutcome = market.winningOutcome;
        const claimableWinningShares = status === 5
          ? marketPositions.filter((p) => p.outcomeIndex === winningOutcome).reduce((sum, p) => sum + p.sharesDisplay, 0)
          : 0;

        const totalMarkedValueUsdc = marketPositions.reduce((sum, p) => sum + p.markedValueUsdc, 0);
        const totalCostBasisUsdc = marketPositions.reduce((sum, p) => sum + p.costBasisUsdc, 0);

        return {
          appId,
          question: market.question,
          status,
          statusName: marketStatusName(status),
          numOutcomes,
          poolUsdc: Number(market.poolBalance || 0) / MICRO_UNITS,
          totalMarkedValueUsdc,
          totalCostBasisUsdc,
          totalUnrealizedPnlUsdc: Number((totalMarkedValueUsdc - totalCostBasisUsdc).toFixed(6)),
          claimableWinningShares,
          holdings: marketPositions,
          lpStake: lpShares > 0 || claimableFeesUsdc > 0
            ? { shares: lpShares, sharesDisplay: lpShares / MICRO_UNITS, claimableFeesUsdc }
            : null,
        };
      })
      .filter((market): market is NonNullable<typeof market> => market !== null)
      .sort((left, right) =>
        right.totalMarkedValueUsdc - left.totalMarkedValueUsdc ||
        (right.lpStake?.shares ?? 0) - (left.lpStake?.shares ?? 0) ||
        right.appId - left.appId
      );

    const summary = {
      marketCount: markets.length,
      traderMarkets: markets.filter((m) => m.holdings.length > 0).length,
      lpMarkets: markets.filter((m) => (m.lpStake?.shares ?? 0) > 0).length,
      shareLines: markets.reduce((sum, m) => sum + m.holdings.length, 0),
      totalMarkedValueUsdc: Number(markets.reduce((sum, m) => sum + m.totalMarkedValueUsdc, 0).toFixed(6)),
      totalCostBasisUsdc: Number(markets.reduce((sum, m) => sum + m.totalCostBasisUsdc, 0).toFixed(6)),
      totalUnrealizedPnlUsdc: Number(markets.reduce((sum, m) => sum + m.totalUnrealizedPnlUsdc, 0).toFixed(6)),
      totalClaimableFeesUsdc: Number(markets.reduce((sum, m) => sum + (m.lpStake?.claimableFeesUsdc ?? 0), 0).toFixed(6)),
      claimableMarkets: markets.filter((m) => m.claimableWinningShares > 0).length,
    };

    return {
      address,
      summary,
      warning: [
        unavailableMarkets > 0 ? `Some market details are unavailable (${unavailableMarkets} missing).` : "",
        hiddenLegacyMarkets > 0 ? `Legacy markets omitted (${hiddenLegacyMarkets} unsupported).` : "",
      ].filter(Boolean).join(" "),
      markets,
    };
  }

  // ── Server ──

  const onboardingToolNames = ["create_wallet", "set_wallet", "request_testnet_tokens", "get_balance"];
  const readToolNames = [
    "list_markets",
    "get_market",
    "get_market_trades",
    "get_price_history",
    "get_positions",
    "get_current_holdings",
    "get_market_positions",
    "get_leaderboard",
  ];
  const tradingToolNames = [
    "buy_shares",
    "sell_shares",
    "enter_lp_active",
    "claim_lp_fees",
    "withdraw_lp_fees",
    "claim_lp_residual",
    "claim_winnings",
    "refund_shares",
  ];
  const availableWriteToolNames = [
    ...(hasCreateMarketConfig ? ["create_market"] : []),
    ...(hasImageUploadConfig ? ["set_market_image"] : []),
    ...(hasTradingConfig ? tradingToolNames : []),
  ];
  const disabledWriteTools = [
    ...(!hasCreateMarketConfig
      ? [{
          tools: ["create_market"],
          reason: hasTradingConfig
            ? "Set FACTORY_APP_ID and PROTOCOL_CONFIG_APP_ID to enable market creation outside the monorepo."
            : "Set USDC_ASA_ID, FACTORY_APP_ID, and PROTOCOL_CONFIG_APP_ID to enable market creation outside the monorepo.",
        }]
      : []),
    ...(!hasTradingConfig
      ? [{
          tools: tradingToolNames,
          reason: "Set USDC_ASA_ID to enable trading, LP, claims, refunds, and USDC-aware balance reporting.",
        }]
      : []),
    ...(!hasImageUploadConfig
      ? [{
          tools: ["set_market_image"],
          reason: "Set PINATA_JWT to enable IPFS image uploads.",
        }]
      : []),
  ];

  const server = new McpServer({ name: "question-market", version: MCP_SERVER_VERSION });
  const blueprintInputSchema = z
    .union([z.string(), z.object({}).passthrough()])
    .describe(
      "Optional public V1 blueprint JSON object or JSON string. If omitted, the MCP server uses its default human_judge blueprint. When provided, the blueprint is validated and compiled with the same rules as the frontend editor."
    );

  // ── Overview ──

  server.tool(
    "question_market",
    "Overview of the question.market MCP server: available tools, onboarding flow, and links.",
    {},
    safe(async () => {
      return text({
        name: "question.market",
        description: "Prediction market protocol on Algorand. Humans and AI agents trade side by side.",
        onboarding: [
          "1. create_wallet() to generate an Algorand account",
          "2. set_wallet(mnemonic) to activate it for this MCP connection",
          "3. request_testnet_tokens(address) to get 10 ALGO + 100 tUSDC",
          hasTradingConfig
            ? "4. Start trading with buy_shares, sell_shares, enter_lp_active, and claim_winnings."
            : "4. To enable trading and market creation outside the monorepo, set USDC_ASA_ID, FACTORY_APP_ID, and PROTOCOL_CONFIG_APP_ID before starting the server.",
        ],
        data_conventions: {
          amounts: "Input parameters use display units (5 = $5 USDC). Response amounts are micro-units (5000000 = $5 USDC). 1 USDC = 1,000,000 micro-USDC. 1 share = 1,000,000 micro-shares.",
          market_status: "0=CREATED, 1=ACTIVE (trading open), 2=RESOLUTION_PENDING, 3=RESOLUTION_PROPOSED, 4=CANCELLED (refund eligible), 5=RESOLVED (claim eligible), 6=DISPUTED",
          wallet: "Call set_wallet once per session. It persists until connection closes or set_wallet is called again. Overrides wallet_index on all write tools.",
        },
        configuration: {
          trading_enabled: hasTradingConfig,
          create_market_enabled: hasCreateMarketConfig,
          set_market_image_enabled: hasImageUploadConfig,
          disabled_write_tools: disabledWriteTools,
        },
        tools: {
          onboarding: onboardingToolNames,
          read: readToolNames,
          write: availableWriteToolNames,
        },
        resources: ["market://{appId}"],
        docs: "https://question.market/docs/mcp",
        faucet: "https://question.market/faucet",
      });
    }, "question_market")
  );

  // ── Read tools ──

  server.tool(
    "list_markets",
    "List prediction markets. Filter by status: 0=CREATED, 1=ACTIVE, 2=RESOLUTION_PENDING, 3=RESOLUTION_PROPOSED, 4=CANCELLED, 5=RESOLVED, 6=DISPUTED",
    { status: z.number().optional().describe("Filter by status code") },
    safe(
      async ({ status }) =>
        text(filterSupportedMarketPayload(await indexer.listMarkets(status !== undefined ? { status } : undefined))),
      "list_markets"
    )
  );

  server.tool(
    "get_market",
    "Get detailed market state: prices, pool, outcomes, deadline, resolution status.",
    { app_id: z.number().int().positive().describe("Market application ID") },
    safe(async ({ app_id }) => {
      try {
        return text(await assertSupportedIndexedMarket(app_id, "get_market"));
      } catch (error) {
        if (isUnsupportedContractVersionError(error)) throw error;
        try {
          const state = await getMarketState(algod, app_id);
          assertSupportedStateVersion(app_id, Number(state.contractVersion ?? CURRENT_MARKET_CONTRACT_VERSION), "get_market");
          return text(state);
        } catch {
          throw new Error(`Market ${app_id} not found.`);
        }
      }
    }, "get_market")
  );

  server.tool(
    "get_market_trades",
    "Get recent trades for a market.",
    {
      app_id: z.number().int().positive().describe("Market application ID"),
      limit: z.number().int().min(1).max(500).optional().default(50),
    },
    safe(
      async ({ app_id, limit }) => text(await indexer.getMarketTrades(app_id, limit)),
      "get_market_trades"
    )
  );

  server.tool(
    "get_price_history",
    "Get historical price snapshots for charting.",
    {
      app_id: z.number().int().positive().describe("Market application ID"),
      limit: z.number().int().min(1).max(500).optional().default(100),
    },
    safe(
      async ({ app_id, limit }) => text(await indexer.getPriceHistory(app_id, limit)),
      "get_price_history"
    )
  );

  server.tool(
    "get_positions",
    "Get all positions for a wallet address across all markets.",
    { address: z.string().describe("Algorand address") },
    safe(async ({ address }) => {
      try {
        return text(await indexer.getUserPositions(address));
      } catch {
        return text([]);
      }
    }, "get_positions")
  );

  server.tool(
    "get_current_holdings",
    "Get a wallet's current holdings with per-market positions, LP stakes, marked value, and claimable resolved exposure.",
    { address: z.string().describe("Algorand address") },
    safe(async ({ address }) => {
      try {
        return text(await getCurrentHoldings(address));
      } catch {
        return text({ positions: [], lpStakes: [], summary: { totalMarkedValue: 0, totalCostBasis: 0 } });
      }
    }, "get_current_holdings")
  );

  server.tool(
    "get_market_positions",
    "Get all user positions in a specific market.",
    { app_id: z.number().int().positive().describe("Market application ID") },
    safe(async ({ app_id }) => text(await indexer.getMarketPositions(app_id)), "get_market_positions")
  );

  server.tool(
    "get_leaderboard",
    "Get the leaderboard: wallets ranked by trading PnL.",
    {},
    safe(async () => text(await indexer.getLeaderboard()), "get_leaderboard")
  );

  // ── Write tools ──

  if (hasCreateMarketConfig) {
    server.tool(
      "create_market",
      `Create a new prediction market atomically. Supports 2-${MAX_ACTIVE_LP_OUTCOMES} outcomes. Provide blueprint to use the same logic for both main and dispute paths, or main_blueprint and dispute_blueprint to author them separately. All custom blueprint JSON is validated and compiled with the same rules as the frontend editor.`,
      {
        question: z.string().max(1000).describe("The question for the market (max 1000 chars)"),
        outcomes: z.array(z.string().max(200)).min(2).max(MAX_ACTIVE_LP_OUTCOMES).describe(`Outcome labels (2-${MAX_ACTIVE_LP_OUTCOMES}, created atomically in one on-chain group)`),
        liquidity_usdc: z.number().positive().default(50).describe("Initial liquidity in USDC (default 50)"),
        deadline_hours: z.number().positive().max(8760).default(24).describe("Hours until market deadline (default 24, max 8760 = 1 year)"),
        lp_entry_max_price: z.number().gt(0).lte(1).default(DEFAULT_LP_ENTRY_MAX_PRICE_FP / 1_000_000).describe("Immutable LP skew cap as a probability from 0 to 1 (default 0.8)"),
        blueprint: blueprintInputSchema.optional().describe("Shared blueprint for both main and dispute paths."),
        main_blueprint: blueprintInputSchema.optional().describe("Optional main-path blueprint JSON. Overrides blueprint for the main path."),
        dispute_blueprint: blueprintInputSchema.optional().describe("Optional dispute-path blueprint JSON. Overrides blueprint for the dispute path."),
        image_url: z.string().url().optional().describe("URL of an image to use as market thumbnail (JPEG, PNG, or WebP, max 2MB). Downloaded and stored by the indexer."),
      },
      safe(async ({ question, outcomes, liquidity_usdc, deadline_hours, lp_entry_max_price, blueprint, main_blueprint, dispute_blueprint, image_url }) => {
        const account = await getAccount(0);
        const liquidityMicro = BigInt(liquidity_usdc * 1_000_000);
        const lpEntryMaxPriceFp = BigInt(Math.round(lp_entry_max_price * 1_000_000));
        await ensureFunded(account, liquidityMicro);

        const status = await algod.status().do();
        const block = await algod.block(Number(status.lastRound)).do();
        const blockTs = Number(block.block.header.timestamp);
        const deadline = blockTs + Math.floor(deadline_hours * 3600);
        // Upload image to IPFS before creating market so CID can go in the note
        let imageCid: string | null = null;
        let imageStatus: "none" | "uploaded" | "failed" | "skipped_no_ipfs" = "none";
        if (image_url && !ipfs) {
          imageStatus = "skipped_no_ipfs";
        } else if (image_url && ipfs) {
          imageStatus = "failed";
          try {
            imageCid = await ipfs.uploadFromUrl(image_url);
            imageStatus = "uploaded";
          } catch {
            // Non-fatal: market will be created without an image CID.
          }
        }

        const noteObj: Record<string, unknown> = { q: question, o: outcomes };
        if (imageCid) noteObj.img = imageCid;
        const notePayload = JSON.stringify(noteObj);
        const sharedBlueprint = blueprint;
        const compiledMainBlueprint = compileCreateMarketBlueprint(
          question,
          outcomes,
          deadline,
          main_blueprint ?? sharedBlueprint,
        );
        const compiledDisputeBlueprint = compileCreateMarketBlueprint(
          question,
          outcomes,
          deadline,
          dispute_blueprint ?? sharedBlueprint,
        );
        const blueprintSource =
          compiledMainBlueprint.source === compiledDisputeBlueprint.source
            ? compiledMainBlueprint.source
            : "mixed";

        let atomicResult: Awaited<ReturnType<typeof createMarketAtomic>>;
        try {
          atomicResult = await createMarketAtomicWithRetry(
            clientConfig(account.addr, account.signer, factoryAppId),
            {
              currencyAsa: usdcAsaId,
              questionHash: textEncoder.encode(question),
              numOutcomes: outcomes.length,
              initialB: 0n,
              lpFeeBps: 200,
              mainBlueprint: compiledMainBlueprint.bytes,
              disputeBlueprint: compiledDisputeBlueprint.bytes,
              deadline,
              challengeWindowSecs: 3600,
              cancellable: true,
              bootstrapDeposit: liquidityMicro,
              lpEntryMaxPriceFp,
              protocolConfigAppId: protocolConfigAppId,
              note: textEncoder.encode(`question.market:j${notePayload}`),
            }
          );
        } catch (error) {
          if (error instanceof AtomicCreateUnsupportedError) {
            throw new Error(error.message);
          }
          throw error;
        }

        return text({
          success: true,
          appId: atomicResult.marketAppId,
          question,
          outcomes,
          blueprint_source: blueprintSource,
          main_blueprint_source: compiledMainBlueprint.source,
          dispute_blueprint_source: compiledDisputeBlueprint.source,
          liquidity: `${liquidity_usdc} USDC`,
          lp_entry_max_price,
          deadline: new Date(deadline * 1000).toISOString(),
          image: imageStatus,
          image_cid: imageCid,
        });
      }, "create_market")
    );
  }

  if (hasImageUploadConfig) {
    server.tool(
      "set_market_image",
      "Upload an image to IPFS for an existing market. Returns the CID that can be used to reference the image.",
      {
        app_id: z.number().int().positive().describe("Market application ID"),
        image_url: z.string().url().describe("URL of the image to upload (JPEG, PNG, or WebP)"),
      },
      safe(async ({ app_id, image_url }) => {
        if (!ipfs) throw new Error("IPFS client not configured. Set PINATA_JWT to enable image uploads.");
        const cid = await ipfs.uploadFromUrl(image_url);
        return text({ success: true, app_id, image: "uploaded", cid });
      }, "set_market_image")
    );
  }

  if (hasTradingConfig) {
    server.tool(
      "buy_shares",
      "Buy outcome shares in an ACTIVE market. Provide either a target share count or a max USDC budget; if share count is omitted, the tool computes the largest purchasable position within the budget. Requires an active wallet (call set_wallet first). Amounts in responses are micro-USDC (1 USDC = 1,000,000).",
      {
        app_id: z.number().int().positive().describe("Market application ID"),
        outcome_index: z.number().int().min(0).max(15).describe("Outcome to buy (0-indexed)"),
        max_cost_usdc: z.number().positive().describe("Maximum cost in USDC (e.g. 5 for $5)"),
        num_shares: z.number().positive().optional().describe("Optional whole-share count in display units (e.g. 1 share). If omitted, the tool computes the largest whole-share position within max_cost_usdc."),
        wallet_index: z.number().int().min(0).optional().default(0).describe("KMD wallet index (default 0 = deployer)"),
      },
      safe(async ({ app_id, outcome_index, max_cost_usdc, num_shares, wallet_index }) => {
        await assertSupportedMarket(app_id, "buy_shares");
        const account = await getAccount(wallet_index);
        const state = await getMarketState(algod, app_id);
        assertMarketStatus(app_id, Number(state.status), [1], "buy shares");
        const maxCost = toMicroUnits(max_cost_usdc);
        const quote = quoteBuyForState(
          state,
          outcome_index,
          maxCost,
          num_shares !== undefined ? sharesFromCount(num_shares) : undefined,
        );

        if (quote.error) {
          throw new Error(quote.error);
        }

        if (num_shares !== undefined && quote.totalCost > maxCost) {
          throw new Error("Trade cost exceeds your maximum.");
        }

        await ensureFunded(account, maxCost);

        // SDK buy() handles app opt-in and ASA opt-ins internally via prepend txns.
        const result = await buy(
          clientConfig(account.addr, account.signer, app_id),
          outcome_index, maxCost, Number(state.numOutcomes), usdcAsaId, quote.shares
        );

        const newState = await getMarketState(algod, app_id);
        return text({
          success: true,
          action: "buy",
          wallet: account.addr.slice(0, 8) + "...",
          outcome_index,
          requested_shares: result.shares.toString(),
          total_cost: result.totalCost.toString(),
          refund_amount: result.refundAmount.toString(),
          max_cost: maxCost.toString(),
          max_cost_usdc,
          prices_after: newState.prices.map((p) => (Number(p) / 10000).toFixed(1) + "%"),
          pool_usdc: (Number(newState.poolBalance) / 1_000_000).toFixed(2),
          tx_id: result.txId,
        });
      }, "buy_shares")
    );

    server.tool(
      "sell_shares",
      "Sell outcome shares back to an ACTIVE market. If num_shares is omitted, the tool reads the on-chain position and sells everything for that outcome. Requires an active wallet (call set_wallet first). Amounts in responses are micro-USDC (1 USDC = 1,000,000).",
      {
        app_id: z.number().int().positive().describe("Market application ID"),
        outcome_index: z.number().int().min(0).max(15).describe("Outcome to sell (0-indexed)"),
        num_shares: z.number().positive().optional().describe("Optional whole-share count in display units. If omitted, the tool sells the full indexed position."),
        wallet_index: z.number().int().min(0).optional().default(0).describe("KMD wallet index"),
      },
      safe(async ({ app_id, outcome_index, num_shares, wallet_index }) => {
        await assertSupportedMarket(app_id, "sell_shares");
        const account = await getAccount(wallet_index);
        const state = await getMarketState(algod, app_id);
        assertMarketStatus(app_id, Number(state.status), [1], "sell shares");
        const shares = num_shares !== undefined
          ? sharesFromCount(num_shares)
          : await getOnChainOutcomeShares(account.addr, app_id, outcome_index);
        if (shares <= 0n) {
          throw new Error("No shares available to sell for this outcome.");
        }

        const result = await sell(
          clientConfig(account.addr, account.signer, app_id),
          outcome_index, 0n, Number(state.numOutcomes), null, usdcAsaId, shares
        );

        const newState = await getMarketState(algod, app_id);
        return text({
          success: true,
          action: "sell",
          wallet: account.addr.slice(0, 8) + "...",
          outcome_index,
          sold_shares: result.shares.toString(),
          net_return: result.netReturn.toString(),
          prices_after: newState.prices.map((p) => (Number(p) / 10000).toFixed(1) + "%"),
          tx_id: result.txId,
        });
      }, "sell_shares")
    );

    server.tool(
      "enter_lp_active",
      "Deposit USDC as a liquidity provider in an ACTIVE market. You earn a share of trading fees (2% of each trade) proportional to your LP stake. Entry is blocked if any outcome price exceeds the market's LP skew cap (default 80%). Requires an active wallet (call set_wallet first).",
      {
        app_id: z.number().int().positive().describe("Market application ID"),
        amount_usdc: z.number().positive().describe("USDC amount (e.g. 10 for $10)"),
        wallet_index: z.number().int().min(0).optional().default(0).describe("KMD wallet index"),
      },
      safe(async ({ app_id, amount_usdc, wallet_index }) => {
        await assertSupportedMarket(app_id, "enter_lp_active");
        const account = await getAccount(wallet_index);
        const amount = BigInt(Math.floor(amount_usdc * 1_000_000));
        const state = await getMarketState(algod, app_id);
        assertMarketStatus(app_id, Number(state.status), [1], "enter as LP");
        const maxPrice = state.prices.reduce((currentMax, price) => (price > currentMax ? price : currentMax), 0n);
        if (maxPrice > state.lpEntryMaxPriceFp) {
          throw new Error(
            `Active LP entry is disabled once any outcome exceeds ${formatPricePct(state.lpEntryMaxPriceFp)}. ` +
            `The current max outcome price is ${formatPricePct(maxPrice)}.`,
          );
        }

        await ensureFunded(account, amount);

        const result = await enterActiveLpForDeposit(
          clientConfig(account.addr, account.signer, app_id),
          amount, Number(state.numOutcomes), usdcAsaId
        );
        const newState = await getMarketState(algod, app_id);
        return text({
          success: true,
          action: "enter_lp_active",
          amount_usdc,
          target_delta_b: result.targetDeltaB.toString(),
          pool_usdc: (Number(newState.poolBalance) / 1_000_000).toFixed(2),
          tx_id: result.txId,
        });
      }, "enter_lp_active")
    );

    server.tool(
      "claim_lp_fees",
      "Move earned LP trading fees from the pool's internal accounting into your withdrawable balance. Does not transfer USDC to your wallet; call withdraw_lp_fees to actually receive the funds. Works on ACTIVE, RESOLVED, or CANCELLED markets.",
      {
        app_id: z.number().int().positive().describe("Market application ID"),
        wallet_index: z.number().int().min(0).optional().default(0).describe("KMD wallet index"),
      },
      safe(async ({ app_id, wallet_index }) => {
        await assertSupportedMarket(app_id, "claim_lp_fees");
        const account = await getAccount(wallet_index);
        const state = await getMarketState(algod, app_id);
        assertMarketStatus(app_id, Number(state.status), [1, 5, 4], "claim LP fees");

        const result = await claimLpFees(
          clientConfig(account.addr, account.signer, app_id),
        );
        return text({
          success: true,
          action: "claim_lp_fees",
          tx_id: result.txId,
        });
      }, "claim_lp_fees")
    );

    server.tool(
      "withdraw_lp_fees",
      "Claim and withdraw all available LP trading fees to your wallet in one call. Combines claim_lp_fees + withdrawal into a single operation. Works on ACTIVE, RESOLVED, or CANCELLED markets. Returns the withdrawn USDC amount.",
      {
        app_id: z.number().int().positive().describe("Market application ID"),
        wallet_index: z.number().int().min(0).optional().default(0).describe("KMD wallet index"),
      },
      safe(async ({ app_id, wallet_index }) => {
        await assertSupportedMarket(app_id, "withdraw_lp_fees");
        const account = await getAccount(wallet_index);
        const state = await getMarketState(algod, app_id);
        assertMarketStatus(app_id, Number(state.status), [1, 5, 4], "withdraw LP fees");

        const result = await collectLpFees(
          clientConfig(account.addr, account.signer, app_id),
          usdcAsaId,
        );
        return text({
          success: true,
          action: "withdraw_lp_fees",
          claim_tx_id: result.claimTxId ?? null,
          withdraw_tx_id: result.withdrawTxId ?? null,
          withdrawn_amount: result.withdrawnAmount.toString(),
        });
      }, "withdraw_lp_fees")
    );

    server.tool(
      "claim_lp_residual",
      "After a market resolves or is cancelled, withdraw your share of the remaining pool liquidity as an LP. Only callable on RESOLVED or CANCELLED markets. This is separate from LP fees; it returns your principal plus any pool surplus.",
      {
        app_id: z.number().int().positive().describe("Market application ID"),
        wallet_index: z.number().int().min(0).optional().default(0).describe("KMD wallet index"),
      },
      safe(async ({ app_id, wallet_index }) => {
        await assertSupportedMarket(app_id, "claim_lp_residual");
        const account = await getAccount(wallet_index);
        const state = await getMarketState(algod, app_id);
        assertMarketStatus(app_id, Number(state.status), [4, 5], "claim LP residual");

        const result = await claimLpResidual(
          clientConfig(account.addr, account.signer, app_id),
          usdcAsaId,
        );
        return text({
          success: true,
          action: "claim_lp_residual",
          tx_id: result.txId,
        });
      }, "claim_lp_residual")
    );

    server.tool(
      "claim_winnings",
      "Claim winning shares from a RESOLVED market. Auto-detects the winning outcome and your full position if parameters are omitted. Payout is 1 USDC per winning share. Amounts in responses are micro-USDC (1 USDC = 1,000,000).",
      {
        app_id: z.number().int().positive().describe("Market application ID"),
        outcome_index: z.number().int().min(0).max(15).optional().describe("Winning outcome index. If omitted, the tool reads the resolved winning outcome from chain state."),
        num_shares: z.number().positive().optional().describe("Optional whole-share count in display units. If omitted, the tool claims the full indexed winning position."),
        wallet_index: z.number().int().min(0).optional().default(0).describe("KMD wallet index"),
      },
      safe(async ({ app_id, outcome_index, num_shares, wallet_index }) => {
        await assertSupportedMarket(app_id, "claim_winnings");
        const account = await getAccount(wallet_index);
        const state = await getMarketState(algod, app_id);
        assertMarketStatus(app_id, Number(state.status), [5], "claim winnings");
        const resolvedOutcome = outcome_index ?? Number(state.winningOutcome);
        const shares = num_shares !== undefined
          ? sharesFromCount(num_shares)
          : await getOnChainOutcomeShares(account.addr, app_id, resolvedOutcome);
        if (shares <= 0n) {
          throw new Error("No indexed winning shares available to claim.");
        }

        const result = await claim(
          clientConfig(account.addr, account.signer, app_id),
          resolvedOutcome, Number(state.numOutcomes), usdcAsaId, shares
        );

        return text({
          success: true,
          action: "claim",
          wallet: account.addr.slice(0, 8) + "...",
          outcome_index: resolvedOutcome,
          claimed_shares: result.shares.toString(),
          payout: result.payout.toString(),
          tx_id: result.txId,
        });
      }, "claim_winnings")
    );

    server.tool(
      "refund_shares",
      "Refund shares from a CANCELLED market at cost basis. If num_shares is omitted, the tool refunds your full position for the selected outcome. Amounts in responses are micro-USDC (1 USDC = 1,000,000).",
      {
        app_id: z.number().int().positive().describe("Market application ID"),
        outcome_index: z.number().int().min(0).max(15).describe("Outcome to refund (0-indexed)"),
        num_shares: z.number().positive().optional().describe("Optional whole-share count in display units. If omitted, the tool refunds the full indexed position."),
        wallet_index: z.number().int().min(0).optional().default(0).describe("KMD wallet index"),
      },
      safe(async ({ app_id, outcome_index, num_shares, wallet_index }) => {
        await assertSupportedMarket(app_id, "refund_shares");
        const account = await getAccount(wallet_index);
        const state = await getMarketState(algod, app_id);
        assertMarketStatus(app_id, Number(state.status), [4], "refund shares");
        const shares = num_shares !== undefined
          ? sharesFromCount(num_shares)
          : await getOnChainOutcomeShares(account.addr, app_id, outcome_index);
        if (shares <= 0n) {
          throw new Error("No indexed shares available to refund for this outcome.");
        }

        const result = await refund(
          clientConfig(account.addr, account.signer, app_id),
          outcome_index, Number(state.numOutcomes), usdcAsaId, shares
        );

        return text({
          success: true,
          action: "refund",
          wallet: account.addr.slice(0, 8) + "...",
          outcome_index,
          refunded_shares: result.shares.toString(),
          refund_amount: result.refundAmount.toString(),
          tx_id: result.txId,
        });
      }, "refund_shares")
    );
  }

  // ── Onboarding tools ──

  server.tool(
    "create_wallet",
    "Generate a new Algorand account. Returns address and mnemonic. Call set_wallet with the mnemonic to activate it for trading.",
    {},
    safe(async () => {
      const wallet = generateWallet();
      return text({
        address: wallet.address,
        mnemonic: wallet.mnemonic,
        next_steps: [
          "Call set_wallet with this mnemonic to activate it.",
          "Call request_testnet_tokens to fund the account.",
          "Start trading with buy_shares, sell_shares, etc.",
        ],
      });
    }, "create_wallet")
  );

  server.tool(
    "set_wallet",
    "Activate a wallet for this MCP connection. All write tools will sign with this account until the connection closes or set_wallet is called again. Overrides the wallet_index parameter on all tools. No restart needed.",
    { mnemonic: z.string().describe("25-word Algorand mnemonic") },
    safe(async ({ mnemonic }) => {
      const account = getMnemonicAccount(mnemonic);
      sessionMnemonic = mnemonic.trim();
      return text({
        active_address: account.addr,
        message: "Wallet activated. All write tools will now sign with this account.",
      });
    }, "set_wallet")
  );

  server.tool(
    "request_testnet_tokens",
    "Request free testnet ALGO and tUSDC from the question.market faucet. Rate limited to once per hour per address.",
    { address: z.string().length(58).describe("Algorand address to fund") },
    safe(async ({ address }) => {
      const resp = await fetch(faucetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address }),
      });
      let data: Record<string, unknown>;
      try {
        data = await resp.json() as Record<string, unknown>;
      } catch {
        throw new Error(`Faucet returned non-JSON response (${resp.status}). The faucet may be down or the address is invalid.`);
      }
      if (!resp.ok || data.error) {
        throw new Error((data.error as string) || `Faucet request failed (${resp.status})`);
      }
      return text(data);
    }, "request_testnet_tokens")
  );

  server.tool(
    "get_balance",
    "Check ALGO and tUSDC balance for an address. Defaults to the active session wallet if address is omitted.",
    { address: z.string().length(58).optional().describe("Address to check (defaults to agent wallet)") },
    safe(async ({ address }) => {
      let addr = address;
      if (!addr) {
        const account = await getAccount();
        addr = account.addr;
      }
      try {
        const info = await algod.accountInformation(addr).do();
        const algoBalance = Number(info.amount) / 1_000_000;
        const assets = (info.assets ?? []) as any[];
        const usdcAsset = hasTradingConfig
          ? assets.find((a: any) => Number(a.assetId ?? a["asset-id"]) === usdcAsaId)
          : undefined;
        const usdcBalance = hasTradingConfig
          ? (usdcAsset ? Number(usdcAsset.amount) / 1_000_000 : 0)
          : null;
        const optedInToUsdc = hasTradingConfig ? !!usdcAsset : null;
        return text({
          address: addr,
          algo: algoBalance,
          usdc: usdcBalance,
          opted_in_to_usdc: optedInToUsdc,
          ...(hasTradingConfig
            ? {}
            : {
                warning:
                  "USDC_ASA_ID is not configured, so USDC balance reporting is disabled. Set USDC_ASA_ID to enable trading tools and USDC-aware balances.",
              }),
        });
      } catch {
        throw new Error(`Address not found or invalid: ${addr}`);
      }
    }, "get_balance")
  );

  // ── Resources ──

  server.resource("market", "market://{appId}", async (uri) => {
    const appId = uri.pathname.replace(/^\/\//, "");
    const market = await assertSupportedIndexedMarket(Number(appId), "market");
    return {
      contents: [
        {
          uri: uri.toString(),
          text: JSON.stringify(market, null, 2),
          mimeType: "application/json",
        },
      ],
    };
  });

  return { server };
}
