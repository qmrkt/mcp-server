import { afterEach, describe, expect, it } from "vitest";
import { createSurfaceHarness, callTool, type TestHarness } from "./setup.js";

let harnessA: TestHarness | undefined;
let harnessB: TestHarness | undefined;

afterEach(async () => {
  await harnessA?.close();
  await harnessB?.close();
  harnessA = undefined;
  harnessB = undefined;
});

describe("red-team session isolation", () => {
  it("does not leak session wallet state across MCP server instances", async () => {
    harnessA = await createSurfaceHarness();
    harnessB = await createSurfaceHarness();

    const { parsed: walletA } = await callTool(harnessA.client, "create_wallet");
    const { parsed: walletB } = await callTool(harnessB.client, "create_wallet");

    const setA = await callTool(harnessA.client, "set_wallet", { mnemonic: walletA.mnemonic });
    const setB = await callTool(harnessB.client, "set_wallet", { mnemonic: walletB.mnemonic });

    expect(setA.isError).toBe(false);
    expect(setB.isError).toBe(false);
    expect(setA.parsed.active_address).toBe(walletA.address);
    expect(setB.parsed.active_address).toBe(walletB.address);
    expect(setA.parsed.active_address).not.toBe(setB.parsed.active_address);

    const { parsed: walletA2 } = await callTool(harnessA.client, "create_wallet");
    const resetA = await callTool(harnessA.client, "set_wallet", { mnemonic: walletA2.mnemonic });

    expect(resetA.isError).toBe(false);
    expect(resetA.parsed.active_address).toBe(walletA2.address);
    expect(resetA.parsed.active_address).not.toBe(setB.parsed.active_address);
  });
});
