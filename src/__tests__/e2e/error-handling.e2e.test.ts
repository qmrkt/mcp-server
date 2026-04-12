import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createE2EHarness, callTool, type E2EHarness } from "./setup.js";

let h: E2EHarness;

beforeAll(async () => {
  h = await createE2EHarness();
}, 120_000);

afterAll(async () => {
  await h?.close();
});

describe("error handling", () => {
  it("buy_shares on non-existent app_id returns error", async () => {
    const { isError, parsed } = await callTool(h.client, "buy_shares", {
      app_id: 999999,
      outcome_index: 0,
      max_cost_usdc: 5,
    });
    expect(isError).toBe(true);
    expect(parsed.error).toBeDefined();
  }, 30_000);

  it("buy_shares with max_cost_usdc=0 returns budget error", async () => {
    const { parsed: market } = await callTool(h.client, "create_market", {
      question: "E2E: zero budget",
      outcomes: ["Yes", "No"],
      liquidity_usdc: 50,
      deadline_hours: 24,
    });

    const { isError } = await callTool(h.client, "buy_shares", {
      app_id: market.appId,
      outcome_index: 0,
      max_cost_usdc: 0,
    });
    expect(isError).toBe(true);
  }, 60_000);

  it("buy_shares with an oversized budget returns chunking guidance", async () => {
    const { parsed: market } = await callTool(h.client, "create_market", {
      question: "E2E: oversized budget",
      outcomes: ["Yes", "No"],
      liquidity_usdc: 50,
      deadline_hours: 24,
    });

    const { isError, parsed } = await callTool(h.client, "buy_shares", {
      app_id: market.appId,
      outcome_index: 0,
      max_cost_usdc: 1000,
    });

    expect(isError).toBe(true);
    expect(parsed.error).toContain("split it into smaller buys");
  }, 60_000);

  it("buy_shares with an oversized explicit share target returns chunking guidance", async () => {
    const { parsed: market } = await callTool(h.client, "create_market", {
      question: "E2E: oversized share target",
      outcomes: ["Yes", "No"],
      liquidity_usdc: 50,
      deadline_hours: 24,
    });

    const { isError, parsed } = await callTool(h.client, "buy_shares", {
      app_id: market.appId,
      outcome_index: 0,
      max_cost_usdc: 2000,
      num_shares: 1000,
    });

    expect(isError).toBe(true);
    expect(parsed.error).toContain("split it into smaller buys");
  }, 60_000);

  it("create_market with deadline_hours <= 0 returns error", async () => {
    const { isError } = await callTool(h.client, "create_market", {
      question: "E2E: negative deadline",
      outcomes: ["Yes", "No"],
      deadline_hours: -1,
    });
    expect(isError).toBe(true);
  }, 30_000);

  it("set_wallet with invalid mnemonic returns error", async () => {
    const { isError } = await callTool(h.client, "set_wallet", {
      mnemonic: "this is not a valid algorand mnemonic phrase at all",
    });
    expect(isError).toBe(true);
  });

  it("error responses include kind field", async () => {
    const { parsed } = await callTool(h.client, "buy_shares", {
      app_id: 999999,
      outcome_index: 0,
      max_cost_usdc: 5,
    });
    expect(parsed.kind).toBeDefined();
    expect(["contract", "validation", "internal", "network"]).toContain(parsed.kind);
  }, 30_000);

  it("error responses include retry field", async () => {
    const { parsed } = await callTool(h.client, "buy_shares", {
      app_id: 999999,
      outcome_index: 0,
      max_cost_usdc: 5,
    });
    expect(typeof parsed.retry).toBe("boolean");
  }, 30_000);
});
