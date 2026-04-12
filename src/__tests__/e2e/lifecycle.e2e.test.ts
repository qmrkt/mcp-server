import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createE2EHarness,
  callTool,
  advanceTimePast,
  createAlgod,
  loadDeployment,
  type E2EHarness,
} from "./setup.js";
import {
  getMarketState,
  triggerResolution,
  proposeResolution,
  finalizeResolution,
  cancel,
} from "@question/sdk/clients/question-market";

let h: E2EHarness;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

beforeAll(async () => {
  const sdkRoot = path.resolve(__dirname, "../../../../sdk");
  const tsxCli = path.resolve(sdkRoot, "node_modules/tsx/dist/cli.mjs");
  if (!fs.existsSync(tsxCli)) {
    throw new Error(`tsx CLI not found at ${tsxCli}`);
  }

  execFileSync(process.execPath, [tsxCli, "src/scripts/deploy-localnet.ts"], {
    cwd: sdkRoot,
    stdio: "pipe",
  });

  h = await createE2EHarness();
}, 120_000);

afterAll(async () => {
  await h?.close();
});

async function withFreshHarness<T>(run: (local: E2EHarness) => Promise<T>): Promise<T> {
  const local = await createE2EHarness();
  try {
    return await run(local);
  } finally {
    await local.close();
  }
}

function deployerConfig(local: E2EHarness, appId: number) {
  return {
    algodClient: local.algod,
    appId,
    sender: local.deployer.addr,
    signer: local.deployer.signer,
  };
}

describe("lifecycle", () => {
  it("create_market returns appId and metadata", async () => {
    const { parsed, isError } = await callTool(h.client, "create_market", {
      question: "E2E: will this test pass?",
      outcomes: ["Yes", "No"],
      liquidity_usdc: 50,
      deadline_hours: 24,
    });

    expect(isError).toBe(false);
    expect(parsed.success).toBe(true);
    expect(parsed.appId).toBeGreaterThan(0);
    expect(parsed.outcomes).toEqual(["Yes", "No"]);
    expect(parsed.blueprint_source).toBe("default");
  }, 60_000);

  it("create_market with 3 outcomes", async () => {
    const { parsed, isError } = await callTool(h.client, "create_market", {
      question: "E2E: three outcomes",
      outcomes: ["A", "B", "C"],
      liquidity_usdc: 100,
      deadline_hours: 24,
    });

    expect(isError).toBe(false);
    expect(parsed.appId).toBeGreaterThan(0);
    expect(parsed.outcomes).toEqual(["A", "B", "C"]);
  }, 60_000);

  it("buy_shares shifts price upward", async () => {
    const { parsed: market } = await callTool(h.client, "create_market", {
      question: "E2E: buy test",
      outcomes: ["Yes", "No"],
      liquidity_usdc: 50,
      deadline_hours: 24,
    });

    const { parsed: buyResult, isError } = await callTool(h.client, "buy_shares", {
      app_id: market.appId,
      outcome_index: 0,
      max_cost_usdc: 10,
    });

    expect(isError).toBe(false);
    expect(buyResult.success).toBe(true);
    // Price of outcome 0 should be > 50% after buying
    const price0 = parseFloat(buyResult.prices_after[0]);
    expect(price0).toBeGreaterThan(50);
  }, 60_000);

  it("sell_shares shifts price downward", async () => {
    const { parsed: market } = await callTool(h.client, "create_market", {
      question: "E2E: sell test",
      outcomes: ["Yes", "No"],
      liquidity_usdc: 50,
      deadline_hours: 24,
    });

    // Buy first
    await callTool(h.client, "buy_shares", {
      app_id: market.appId,
      outcome_index: 0,
      max_cost_usdc: 10,
    });

    // Get price after buy
    const stateAfterBuy = await getMarketState(h.algod, market.appId);
    const priceAfterBuy = Number(stateAfterBuy.prices[0]);

    // Sell
    const { parsed: sellResult, isError } = await callTool(h.client, "sell_shares", {
      app_id: market.appId,
      outcome_index: 0,
      num_shares: 1,
    });

    expect(isError).toBe(false);
    expect(sellResult.success).toBe(true);

    // Price should have decreased
    const stateAfterSell = await getMarketState(h.algod, market.appId);
    expect(Number(stateAfterSell.prices[0])).toBeLessThan(priceAfterBuy);
  }, 60_000);

  it("enter_lp_active increases pool", async () => {
    const { parsed: market } = await callTool(h.client, "create_market", {
      question: "E2E: LP test",
      outcomes: ["Yes", "No"],
      liquidity_usdc: 50,
      deadline_hours: 24,
    });

    const stateBefore = await getMarketState(h.algod, market.appId);
    const poolBefore = Number(stateBefore.poolBalance);

    const { parsed, isError } = await callTool(h.client, "enter_lp_active", {
      app_id: market.appId,
      amount_usdc: 25,
    });

    expect(isError).toBe(false);
    expect(parsed.success).toBe(true);

    const stateAfter = await getMarketState(h.algod, market.appId);
    expect(Number(stateAfter.poolBalance)).toBeGreaterThan(poolBefore);
  }, 60_000);

  it("claim_lp_residual works after cancellation", async () => {
    const { parsed: market } = await callTool(h.client, "create_market", {
      question: "E2E: LP residual",
      outcomes: ["Yes", "No"],
      liquidity_usdc: 50,
      deadline_hours: 24,
    });

    await callTool(h.client, "enter_lp_active", {
      app_id: market.appId,
      amount_usdc: 25,
    });

    await cancel(deployerConfig(h, market.appId), 2);

    const { parsed, isError } = await callTool(h.client, "claim_lp_residual", {
      app_id: market.appId,
    });

    expect(isError).toBe(false);
    expect(parsed.success).toBe(true);
  }, 60_000);

  it("buy+sell round-trip is net loss (fees)", async () => {
    const { parsed: market } = await callTool(h.client, "create_market", {
      question: "E2E: round-trip cost",
      outcomes: ["Yes", "No"],
      liquidity_usdc: 50,
      deadline_hours: 24,
    });

    const { parsed: buyResult } = await callTool(h.client, "buy_shares", {
      app_id: market.appId,
      outcome_index: 0,
      max_cost_usdc: 10,
    });
    const totalCost = BigInt(buyResult.total_cost);

    const { parsed: sellResult } = await callTool(h.client, "sell_shares", {
      app_id: market.appId,
      outcome_index: 0,
      num_shares: 1,
    });
    const netReturn = BigInt(sellResult.net_return);

    // Fees mean you always lose on a round-trip
    expect(netReturn).toBeLessThan(totalCost);
  }, 60_000);

  it("multiple buys increase price monotonically", async () => {
    const { parsed: market } = await callTool(h.client, "create_market", {
      question: "E2E: monotonic price",
      outcomes: ["Yes", "No"],
      liquidity_usdc: 50,
      deadline_hours: 24,
    });

    const prices: number[] = [];
    for (let i = 0; i < 3; i++) {
      const { parsed } = await callTool(h.client, "buy_shares", {
        app_id: market.appId,
        outcome_index: 0,
        max_cost_usdc: 5,
      });
      prices.push(parseFloat(parsed.prices_after[0]));
    }

    // Each buy should push price higher
    for (let i = 1; i < prices.length; i++) {
      expect(prices[i]).toBeGreaterThanOrEqual(prices[i - 1]);
    }
  }, 120_000);

  it("claim_winnings pays out after resolution", async () => withFreshHarness(async (local) => {
    const { parsed: market, isError: createErr } = await callTool(local.client, "create_market", {
      question: "E2E: claim winnings",
      outcomes: ["Yes", "No"],
      liquidity_usdc: 50,
      deadline_hours: 24,
    });
    expect(createErr).toBe(false);

    const { parsed: buyResult, isError: buyErr } = await callTool(local.client, "buy_shares", {
      app_id: market.appId,
      outcome_index: 0,
      max_cost_usdc: 10,
    });
    expect(buyErr).toBe(false);
    const displayShares = Number(BigInt(buyResult.requested_shares)) / 1_000_000;

    const stateBeforeResolution = await getMarketState(local.algod, market.appId);
    await advanceTimePast(local.algod, local.deployer, Number(stateBeforeResolution.deadline) + 1);

    await triggerResolution(deployerConfig(local, market.appId), Number(stateBeforeResolution.numOutcomes));
    await proposeResolution(
      deployerConfig(local, market.appId),
      0,
      createHash("sha256").update("mcp-claim-winnings").digest(),
      Number(stateBeforeResolution.numOutcomes),
      local.deployment.usdcAsaId,
    );

    const afterProposal = await getMarketState(local.algod, market.appId);
    await advanceTimePast(
      local.algod,
      local.deployer,
      Number(afterProposal.proposalTimestamp) + Number(afterProposal.challengeWindowSecs) + 1,
    );
    await finalizeResolution(deployerConfig(local, market.appId), Number(afterProposal.numOutcomes));

    const { parsed: claimResult, isError: claimErr } = await callTool(local.client, "claim_winnings", {
      app_id: market.appId,
      num_shares: displayShares,
    });

    expect(claimErr).toBe(false);
    expect(claimResult.success).toBe(true);
    expect(claimResult.outcome_index).toBe(0);
    expect(BigInt(claimResult.claimed_shares)).toBe(BigInt(buyResult.requested_shares));
    expect(BigInt(claimResult.payout)).toBeGreaterThan(0n);
  }), 90_000);

  it("refund_shares returns funds after cancellation", async () => withFreshHarness(async (local) => {
    const { parsed: market, isError: createErr } = await callTool(local.client, "create_market", {
      question: "E2E: refund shares",
      outcomes: ["Yes", "No"],
      liquidity_usdc: 50,
      deadline_hours: 24,
    });
    expect(createErr).toBe(false);

    const { parsed: buyResult, isError: buyErr } = await callTool(local.client, "buy_shares", {
      app_id: market.appId,
      outcome_index: 1,
      max_cost_usdc: 10,
    });
    expect(buyErr).toBe(false);
    const displayShares = Number(BigInt(buyResult.requested_shares)) / 1_000_000;
    const stateBeforeCancel = await getMarketState(local.algod, market.appId);
    await cancel(deployerConfig(local, market.appId), Number(stateBeforeCancel.numOutcomes));

    const { parsed: refundResult, isError: refundErr } = await callTool(local.client, "refund_shares", {
      app_id: market.appId,
      outcome_index: 1,
      num_shares: displayShares,
    });

    expect(refundErr).toBe(false);
    expect(refundResult.success).toBe(true);
    expect(refundResult.outcome_index).toBe(1);
    expect(BigInt(refundResult.refunded_shares)).toBe(BigInt(buyResult.requested_shares));
    expect(BigInt(refundResult.refund_amount)).toBeGreaterThan(0n);
  }), 90_000);
});
