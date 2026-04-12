import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { createSurfaceHarness, callTool, STUB_CONFIG, type TestHarness } from "./setup.js";

let harness: TestHarness;

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockReset();
});

afterEach(async () => {
  await harness?.close();
  vi.unstubAllGlobals();
});

function jsonResponse(data: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  }));
}

describe("request_testnet_tokens (mocked faucet)", () => {
  it("success path returns faucet data", async () => {
    harness = await createSurfaceHarness();
    mockFetch.mockReturnValueOnce(jsonResponse({ algo: 10, usdc: 100, txId: "abc" }));

    const { parsed, isError } = await callTool(harness.client, "request_testnet_tokens", {
      address: "A".repeat(58),
    });

    expect(isError).toBe(false);
    expect(parsed.algo).toBe(10);
    expect(mockFetch).toHaveBeenCalledWith(
      STUB_CONFIG.faucetUrl,
      expect.objectContaining({ method: "POST" })
    );
  });

  it("faucet 429 rate limit surfaces error", async () => {
    harness = await createSurfaceHarness();
    mockFetch.mockReturnValueOnce(jsonResponse({ error: "rate limit exceeded" }, 429));

    const { isError, parsed } = await callTool(harness.client, "request_testnet_tokens", {
      address: "A".repeat(58),
    });

    expect(isError).toBe(true);
    expect(parsed.error).toContain("rate limit");
  });

  it("faucet error field surfaces as error", async () => {
    harness = await createSurfaceHarness();
    mockFetch.mockReturnValueOnce(jsonResponse({ error: "Cannot send to faucet address" }));

    const { isError, parsed } = await callTool(harness.client, "request_testnet_tokens", {
      address: "A".repeat(58),
    });

    expect(isError).toBe(true);
    expect(parsed.error).toContain("faucet");
  });

  it("faucet network failure returns structured error", async () => {
    harness = await createSurfaceHarness();
    mockFetch.mockRejectedValueOnce(new Error("fetch failed"));

    const { isError, parsed } = await callTool(harness.client, "request_testnet_tokens", {
      address: "A".repeat(58),
    });

    expect(isError).toBe(true);
    expect(parsed.kind).toBe("network");
  });

  it("faucet non-JSON body does not crash", async () => {
    harness = await createSurfaceHarness();
    mockFetch.mockReturnValueOnce(
      Promise.resolve(new Response("Internal Server Error", { status: 500 }))
    );

    const { isError } = await callTool(harness.client, "request_testnet_tokens", {
      address: "A".repeat(58),
    });

    expect(isError).toBe(true);
  });
});

describe("create_wallet + set_wallet round-trip", () => {
  it("create_wallet mnemonic round-trips through set_wallet", async () => {
    harness = await createSurfaceHarness();

    const { parsed: wallet } = await callTool(harness.client, "create_wallet");
    expect(wallet.address).toHaveLength(58);
    expect(wallet.mnemonic.split(" ")).toHaveLength(25);

    const { parsed: setResult, isError } = await callTool(harness.client, "set_wallet", {
      mnemonic: wallet.mnemonic,
    });

    expect(isError).toBe(false);
    expect(setResult.active_address).toBe(wallet.address);
  });

  it("set_wallet with empty string fails", async () => {
    harness = await createSurfaceHarness();
    const { isError } = await callTool(harness.client, "set_wallet", { mnemonic: "" });
    expect(isError).toBe(true);
  });

  it("set_wallet with 24-word BIP39 mnemonic fails", async () => {
    harness = await createSurfaceHarness();
    const bip39 = "abandon ".repeat(23) + "art";
    const { isError } = await callTool(harness.client, "set_wallet", { mnemonic: bip39 });
    expect(isError).toBe(true);
  });
});
