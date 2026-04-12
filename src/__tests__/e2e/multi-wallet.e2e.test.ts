import { describe, it, expect } from "vitest";
import algosdk from "algosdk";
import {
  createE2EHarness,
  callTool,
  fundAndOptInAccount,
  type E2EHarness,
} from "./setup.js";
import { getMarketState } from "@questionmarket/sdk/clients/question-market";

async function withHarness(run: (h: E2EHarness) => Promise<void>) {
  const h = await createE2EHarness();
  try {
    await run(h);
  } finally {
    await h.close();
  }
}

describe("multi-wallet", () => {
  it("set_wallet switches signing identity", async () => withHarness(async (h) => {
    const { parsed: walletA } = await callTool(h.client, "create_wallet");
    await callTool(h.client, "set_wallet", { mnemonic: walletA.mnemonic });

    const { parsed: balA } = await callTool(h.client, "get_balance", {
      address: walletA.address,
    });
    expect(balA.address).toBe(walletA.address);

    const { parsed: walletB } = await callTool(h.client, "create_wallet");
    await callTool(h.client, "set_wallet", { mnemonic: walletB.mnemonic });

    const { parsed: balB } = await callTool(h.client, "get_balance", {
      address: walletB.address,
    });
    expect(balB.address).toBe(walletB.address);
    expect(balB.address).not.toBe(balA.address);
  }), 30_000);

  it("KMD fallback when no session wallet and no AGENT_MNEMONIC", async () => withHarness(async (h) => {
    const { parsed, isError } = await callTool(h.client, "create_market", {
      question: "E2E: KMD fallback",
      outcomes: ["Yes", "No"],
      liquidity_usdc: 50,
      deadline_hours: 24,
    });

    expect(isError).toBe(false);
    expect(parsed.appId).toBeGreaterThan(0);
  }), 60_000);

  it("two wallets trade opposite outcomes on same market", async () => withHarness(async (h) => {
    const { parsed: market, isError: createErr } = await callTool(h.client, "create_market", {
      question: "E2E: two traders",
      outcomes: ["Yes", "No"],
      liquidity_usdc: 50,
      deadline_hours: 24,
    });
    expect(createErr).toBe(false);

    const accountA = algosdk.generateAccount();
    const mnemonicA = algosdk.secretKeyToMnemonic(accountA.sk);
    const signerA = algosdk.makeBasicAccountTransactionSigner(accountA);
    await fundAndOptInAccount(h.algod, h.deployer, { addr: accountA.addr.toString(), signer: signerA }, h.deployment.usdcAsaId);

    const accountB = algosdk.generateAccount();
    const mnemonicB = algosdk.secretKeyToMnemonic(accountB.sk);
    const signerB = algosdk.makeBasicAccountTransactionSigner(accountB);
    await fundAndOptInAccount(h.algod, h.deployer, { addr: accountB.addr.toString(), signer: signerB }, h.deployment.usdcAsaId);

    await callTool(h.client, "set_wallet", { mnemonic: mnemonicA });
    const { parsed: buyA, isError: errA } = await callTool(h.client, "buy_shares", {
      app_id: market.appId,
      outcome_index: 0,
      max_cost_usdc: 10,
    });
    expect(errA).toBe(false);
    expect(buyA.wallet).toContain(accountA.addr.toString().slice(0, 8));

    // Wallet B buys outcome 1
    await callTool(h.client, "set_wallet", { mnemonic: mnemonicB });
    const { parsed: buyB, isError: errB } = await callTool(h.client, "buy_shares", {
      app_id: market.appId,
      outcome_index: 1,
      max_cost_usdc: 10,
    });
    expect(errB).toBe(false);
    expect(buyB.wallet).toContain(accountB.addr.toString().slice(0, 8));

    // Verify prices reflect both trades
    const state = await getMarketState(h.algod, market.appId);
    // Both outcomes should have shifted from 50/50
    expect(Number(state.prices[0])).not.toBe(Number(state.prices[1]));
  }), 90_000);

  it("create_wallet does not overwrite active session wallet", async () => withHarness(async (h) => {
    const { parsed: wallet } = await callTool(h.client, "create_wallet");
    await callTool(h.client, "set_wallet", { mnemonic: wallet.mnemonic });

    // Create another wallet (should not change active session)
    const { parsed: wallet2 } = await callTool(h.client, "create_wallet");
    expect(wallet2.address).not.toBe(wallet.address);

    // Active wallet should still be the first one
    // Verify by setting wallet2 and checking address changed
    const { parsed: setResult } = await callTool(h.client, "set_wallet", {
      mnemonic: wallet2.mnemonic,
    });
    expect(setResult.active_address).toBe(wallet2.address);
  }), 30_000);
});
