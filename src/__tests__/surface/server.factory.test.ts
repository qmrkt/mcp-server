import { describe, it, expect, afterEach } from "vitest";
import { createSurfaceHarness, callTool, type TestHarness } from "./setup.js";

let harness: TestHarness;

afterEach(async () => {
  await harness?.close();
});

describe("server factory", () => {
  it("lists all expected tools", async () => {
    harness = await createSurfaceHarness();
    const result = await harness.client.listTools();
    const names = result.tools.map((t) => t.name);

    const expected = [
      "question_market",
      "list_markets",
      "get_market",
      "get_market_trades",
      "get_price_history",
      "get_positions",
      "get_current_holdings",
      "get_market_positions",
      "get_leaderboard",
      "create_market",
      "set_market_image",
      "buy_shares",
      "sell_shares",
      "enter_lp_active",
      "claim_lp_fees",
      "withdraw_lp_fees",
      "claim_lp_residual",
      "claim_winnings",
      "refund_shares",
      "create_wallet",
      "set_wallet",
      "request_testnet_tokens",
      "get_balance",
    ];

    for (const name of expected) {
      expect(names, `missing tool: ${name}`).toContain(name);
    }
    expect(names.length).toBe(expected.length);
  });

  it("question_market overview matches registered tools", async () => {
    harness = await createSurfaceHarness();
    const { parsed } = await callTool(harness.client, "question_market");

    expect(parsed.name).toBe("question.market");
    expect(parsed.tools.onboarding).toContain("create_wallet");
    expect(parsed.tools.onboarding).toContain("set_wallet");
    expect(parsed.tools.read).toContain("list_markets");
    expect(parsed.tools.read).toContain("get_current_holdings");
    expect(parsed.tools.write).toContain("buy_shares");
    expect(parsed.tools.write).toContain("enter_lp_active");
    expect(parsed.tools.write).toContain("claim_lp_residual");
    expect(parsed.tools.write).toContain("claim_winnings");
    expect(parsed.tools.write).toContain("refund_shares");
    expect(parsed.configuration.trading_enabled).toBe(true);
    expect(parsed.configuration.create_market_enabled).toBe(true);
    expect(parsed.configuration.set_market_image_enabled).toBe(true);
    expect(parsed.configuration.disabled_write_tools).toEqual([]);
    expect(parsed.resources).toContain("market://{appId}");
  });

  it("hides write tools when deployment ids are missing", async () => {
    harness = await createSurfaceHarness({
      factoryAppId: 0,
      protocolConfigAppId: 0,
      usdcAsaId: 0,
      indexerWriteToken: "",
    });

    const result = await harness.client.listTools();
    const names = result.tools.map((t) => t.name);

    expect(names).not.toContain("create_market");
    expect(names).not.toContain("buy_shares");
    expect(names).not.toContain("sell_shares");
    expect(names).not.toContain("enter_lp_active");
    expect(names).not.toContain("claim_winnings");
    expect(names).not.toContain("refund_shares");
    expect(names).not.toContain("set_market_image");

    const { parsed } = await callTool(harness.client, "question_market");
    expect(parsed.tools.write).toEqual([]);
    expect(parsed.configuration.trading_enabled).toBe(false);
    expect(parsed.configuration.create_market_enabled).toBe(false);
    expect(parsed.configuration.set_market_image_enabled).toBe(false);
    expect(parsed.configuration.disabled_write_tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tools: ["create_market"] }),
        expect.objectContaining({ tools: ["set_market_image"] }),
      ]),
    );
  });

  it("create_wallet returns valid address and 25-word mnemonic", async () => {
    harness = await createSurfaceHarness();
    const { parsed, isError } = await callTool(harness.client, "create_wallet");

    expect(isError).toBe(false);
    expect(parsed.address).toHaveLength(58);
    expect(parsed.mnemonic.split(" ")).toHaveLength(25);
    expect(parsed.next_steps).toBeDefined();
  });

  it("set_wallet activates a valid mnemonic", async () => {
    harness = await createSurfaceHarness();
    // Generate a wallet, then set it
    const { parsed: wallet } = await callTool(harness.client, "create_wallet");
    const { parsed, isError } = await callTool(harness.client, "set_wallet", {
      mnemonic: wallet.mnemonic,
    });

    expect(isError).toBe(false);
    expect(parsed.active_address).toBe(wallet.address);
  });

  it("set_wallet rejects invalid mnemonic", async () => {
    harness = await createSurfaceHarness();
    const { isError, parsed } = await callTool(harness.client, "set_wallet", {
      mnemonic: "not a valid mnemonic at all",
    });

    expect(isError).toBe(true);
    expect(parsed.error).toBeDefined();
  });

  it("two server instances have isolated session state", async () => {
    harness = await createSurfaceHarness();
    const harness2 = await createSurfaceHarness();

    // Generate and set a wallet on harness 1
    const { parsed: wallet } = await callTool(harness.client, "create_wallet");
    await callTool(harness.client, "set_wallet", { mnemonic: wallet.mnemonic });

    // Harness 2 should NOT have the wallet set
    // set_wallet on harness 2 with a different wallet should not affect harness 1
    const { parsed: wallet2 } = await callTool(harness2.client, "create_wallet");
    await callTool(harness2.client, "set_wallet", { mnemonic: wallet2.mnemonic });

    // Verify independence: set another wallet on harness 1, harness 2 unchanged
    const { parsed: wallet3 } = await callTool(harness.client, "create_wallet");
    const { parsed: result } = await callTool(harness.client, "set_wallet", {
      mnemonic: wallet3.mnemonic,
    });
    expect(result.active_address).toBe(wallet3.address);

    await harness2.close();
  });
});
