/**
 * E2E test harness: creates an MCP server+client against real localnet.
 * Requires AlgoKit localnet running (docker) and protocol deployed.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import algosdk from "algosdk";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createQuestionMarketServer, type ServerConfig } from "../../server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Deployment
// ---------------------------------------------------------------------------

export interface Deployment {
  network: string;
  deployer: string;
  protocolConfigAppId: number;
  marketFactoryAppId: number;
  usdcAsaId: number;
}

export function loadDeployment(): Deployment {
  const p = path.resolve(__dirname, "../../../../sdk/protocol-deployment.json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

// ---------------------------------------------------------------------------
// Localnet clients
// ---------------------------------------------------------------------------

const ALGOD_TOKEN = "a".repeat(64);
const ALGOD_SERVER = "http://localhost";
const ALGOD_PORT = 4001;
const KMD_TOKEN = "a".repeat(64);
const KMD_SERVER = "http://localhost";
const KMD_PORT = 4002;

export function createAlgod() {
  return new algosdk.Algodv2(ALGOD_TOKEN, ALGOD_SERVER, ALGOD_PORT);
}

export function createKmd() {
  return new algosdk.Kmd(KMD_TOKEN, KMD_SERVER, KMD_PORT);
}

// ---------------------------------------------------------------------------
// Account helpers
// ---------------------------------------------------------------------------

export async function getLocalnetAccount(
  kmd: algosdk.Kmd,
  index = 0
): Promise<{ addr: string; sk: Uint8Array; signer: algosdk.TransactionSigner }> {
  const wallets = await kmd.listWallets();
  const dw = wallets.wallets.find((w: any) => w.name === "unencrypted-default-wallet")!;
  const handle = (await kmd.initWalletHandle(dw.id, "")).wallet_handle_token;
  const keys = await kmd.listKeys(handle);
  const addr = keys.addresses[index];
  const sk = (await kmd.exportKey(handle, "", addr)).private_key;
  await kmd.releaseWalletHandle(handle);
  return {
    addr,
    sk,
    signer: algosdk.makeBasicAccountTransactionSigner({ addr, sk } as any),
  };
}

export async function getLocalnetAccountByAddress(
  kmd: algosdk.Kmd,
  address: string
): Promise<{ addr: string; sk: Uint8Array; signer: algosdk.TransactionSigner }> {
  const wallets = await kmd.listWallets();
  const dw = wallets.wallets.find((w: any) => w.name === "unencrypted-default-wallet")!;
  const handle = (await kmd.initWalletHandle(dw.id, "")).wallet_handle_token;
  const keys = await kmd.listKeys(handle);
  if (!keys.addresses.includes(address)) {
    await kmd.releaseWalletHandle(handle);
    throw new Error(`Address ${address} not found in localnet KMD wallet`);
  }
  const sk = (await kmd.exportKey(handle, "", address)).private_key;
  await kmd.releaseWalletHandle(handle);
  return {
    addr: address,
    sk,
    signer: algosdk.makeBasicAccountTransactionSigner({ addr: address, sk } as any),
  };
}

export async function fundAccount(
  algod: algosdk.Algodv2,
  deployer: { addr: string; signer: algosdk.TransactionSigner },
  target: string,
  usdcAsaId: number,
  algoAmount = 50_000_000n,
  usdcAmount = 500_000_000n
) {
  const sp = await algod.getTransactionParams().do();

  // ALGO
  const payTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: deployer.addr, receiver: target, amount: algoAmount, suggestedParams: sp,
  });
  const atc1 = new algosdk.AtomicTransactionComposer();
  atc1.addTransaction({ txn: payTxn, signer: deployer.signer });
  await atc1.execute(algod, 4);

  // USDC opt-in (from target -- need a signer for the target)
  // Skip opt-in here; the MCP server handles it via ensureFunded or buy flow.
  // Just send USDC from deployer (target must already be opted in).
  try {
    await algod.accountAssetInformation(target, usdcAsaId).do();
    // Already opted in, send USDC
    const sp2 = await algod.getTransactionParams().do();
    const usdcTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: deployer.addr, receiver: target, assetIndex: usdcAsaId, amount: usdcAmount, suggestedParams: sp2,
    });
    const atc2 = new algosdk.AtomicTransactionComposer();
    atc2.addTransaction({ txn: usdcTxn, signer: deployer.signer });
    await atc2.execute(algod, 4);
  } catch {
    // Not opted in yet; the MCP buy flow will handle it
  }
}

export async function fundAndOptInAccount(
  algod: algosdk.Algodv2,
  deployer: { addr: string; signer: algosdk.TransactionSigner },
  target: { addr: string; signer: algosdk.TransactionSigner },
  usdcAsaId: number,
  algoAmount = 200_000_000n,
  usdcAmount = 500_000_000n
) {
  // ALGO
  const sp = await algod.getTransactionParams().do();
  const payTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: deployer.addr, receiver: target.addr, amount: algoAmount, suggestedParams: sp,
  });
  const atc1 = new algosdk.AtomicTransactionComposer();
  atc1.addTransaction({ txn: payTxn, signer: deployer.signer });
  await atc1.execute(algod, 4);

  // USDC opt-in from target
  try {
    await algod.accountAssetInformation(target.addr, usdcAsaId).do();
  } catch {
    const sp2 = await algod.getTransactionParams().do();
    const optInTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: target.addr, receiver: target.addr, assetIndex: usdcAsaId, amount: 0n, suggestedParams: sp2,
    });
    const atc = new algosdk.AtomicTransactionComposer();
    atc.addTransaction({ txn: optInTxn, signer: target.signer });
    await atc.execute(algod, 4);
  }

  // USDC transfer
  const sp3 = await algod.getTransactionParams().do();
  const usdcTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: deployer.addr, receiver: target.addr, assetIndex: usdcAsaId, amount: usdcAmount, suggestedParams: sp3,
  });
  const atc3 = new algosdk.AtomicTransactionComposer();
  atc3.addTransaction({ txn: usdcTxn, signer: deployer.signer });
  await atc3.execute(algod, 4);
}

// ---------------------------------------------------------------------------
// Time management
// ---------------------------------------------------------------------------

export async function currentBlockTimestamp(algod: algosdk.Algodv2): Promise<number> {
  const status = await algod.status().do();
  const block = await algod.block(Number(status.lastRound)).do();
  return Number(block.block.header.timestamp);
}

async function mineTick(
  algod: algosdk.Algodv2,
  account: { addr: string; signer: algosdk.TransactionSigner }
) {
  const sp = await algod.getTransactionParams().do();
  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: account.addr,
    receiver: account.addr,
    amount: 0n,
    suggestedParams: sp,
    note: new TextEncoder().encode(`mcp-e2e-tick:${Date.now()}:${Math.random()}`),
  });
  const atc = new algosdk.AtomicTransactionComposer();
  atc.addTransaction({ txn, signer: account.signer });
  await atc.execute(algod, 4);
}

async function resetBlockOffsetTimestamp(
  algod: algosdk.Algodv2,
  account: { addr: string; signer: algosdk.TransactionSigner }
) {
  try {
    await (algod as any).setBlockOffsetTimestamp(0).do();
    await mineTick(algod, account);
  } catch {
    // Older localnet algods may not expose the offset API.
  }
}

export async function advanceTimePast(
  algod: algosdk.Algodv2,
  deployer: { addr: string; signer: algosdk.TransactionSigner },
  target: number
) {
  const ts = await currentBlockTimestamp(algod);
  if (ts < target) {
    let offset = 0;
    try {
      const resp = await (algod as any).getBlockOffsetTimestamp().do();
      offset = Number((resp as any).offset ?? 0);
    } catch {}
    await (algod as any).setBlockOffsetTimestamp(offset + (target - ts) + 2).do();
  }
  // Mine a tick
  const sp = await algod.getTransactionParams().do();
  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: deployer.addr, receiver: deployer.addr, amount: 0n, suggestedParams: sp,
    note: new TextEncoder().encode(`tick:${Date.now()}`),
  });
  const atc = new algosdk.AtomicTransactionComposer();
  atc.addTransaction({ txn, signer: deployer.signer });
  await atc.execute(algod, 4);
}

// ---------------------------------------------------------------------------
// MCP test harness
// ---------------------------------------------------------------------------

export type E2EHarness = {
  client: Client;
  algod: algosdk.Algodv2;
  kmd: algosdk.Kmd;
  deployment: Deployment;
  deployer: { addr: string; signer: algosdk.TransactionSigner };
  config: ServerConfig;
  close: () => Promise<void>;
};

export async function createE2EHarness(): Promise<E2EHarness> {
  const algod = createAlgod();
  const kmd = createKmd();

  // Verify localnet is running
  await algod.status().do();

  const deployment = loadDeployment();
  const deployer = await getLocalnetAccountByAddress(kmd, deployment.deployer);
  await resetBlockOffsetTimestamp(algod, deployer);

  // The deployer (index 0) may be low on ALGO after protocol deployment.
  // Find the richest KMD account and top up the deployer.
  const wallets = await kmd.listWallets();
  const dw = wallets.wallets.find((w: any) => w.name === "unencrypted-default-wallet")!;
  const handle = (await kmd.initWalletHandle(dw.id, "")).wallet_handle_token;
  const allKeys = await kmd.listKeys(handle);
  await kmd.releaseWalletHandle(handle);

  for (const addr of allKeys.addresses) {
    if (addr === deployer.addr) continue;
    const info = await algod.accountInformation(addr).do();
    if (Number(info.amount) > 10_000_000_000) {
      // Fund the deployer with 500,000 ALGO from this rich account
      const funder = await getLocalnetAccount(kmd, allKeys.addresses.indexOf(addr));
      const sp = await algod.getTransactionParams().do();
      const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: funder.addr, receiver: deployer.addr, amount: 500_000_000_000n, suggestedParams: sp,
        note: new TextEncoder().encode(`harness-fund:${Date.now()}:${Math.random()}`),
      });
      const atc = new algosdk.AtomicTransactionComposer();
      atc.addTransaction({ txn, signer: funder.signer });
      await atc.execute(algod, 4);
      break;
    }
  }

  const config: ServerConfig = {
    indexerUrl: "http://localhost:3001",
    indexerAuth: "",
    indexerWriteToken: "",
    algodServer: ALGOD_SERVER,
    algodPort: ALGOD_PORT,
    algodToken: ALGOD_TOKEN,
    kmdServer: KMD_SERVER,
    kmdPort: KMD_PORT,
    kmdToken: KMD_TOKEN,
    factoryAppId: deployment.marketFactoryAppId,
    protocolConfigAppId: deployment.protocolConfigAppId,
    usdcAsaId: deployment.usdcAsaId,
    agentMnemonic: "",
    faucetUrl: "http://localhost:9999/faucet", // no real faucet on localnet
  };

  const { server } = createQuestionMarketServer(config);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "e2e-test", version: "1.0" });
  await client.connect(clientTransport);

  return {
    client,
    algod,
    kmd,
    deployment,
    deployer,
    config,
    close: () => client.close(),
  };
}

/** Call a tool and parse the JSON response. */
export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<{ parsed: any; isError: boolean; raw: string }> {
  const result = await client.callTool({ name, arguments: args });
  const raw = (result.content as any)?.[0]?.text ?? "";
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = raw;
  }
  return { parsed, isError: !!result.isError, raw };
}
