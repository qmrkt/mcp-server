import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { createSurfaceHarness, callTool, STUB_CONFIG, type TestHarness } from "./setup.js";

let harness: TestHarness;

// Mock fetch globally for indexer/faucet calls
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

describe("read tools (mocked indexer)", () => {
  it("list_markets filters out legacy contract versions", async () => {
    harness = await createSurfaceHarness();
    const mockMarkets = [
      { appId: 100, status: 1, contractVersion: 2 },
      { appId: 200, status: 1, contractVersion: 3 },
      { appId: 300, status: 5, contractVersion: 4 },
    ];
    mockFetch.mockReturnValueOnce(jsonResponse(mockMarkets));

    const { parsed, isError } = await callTool(harness.client, "list_markets");
    expect(isError).toBe(false);
    expect(parsed).toHaveLength(1);
    expect(parsed.map((market: { appId: number }) => market.appId)).toEqual([300]);
  });

  it("list_markets returns indexer data", async () => {
    harness = await createSurfaceHarness();
    const mockMarkets = [
      { appId: 100, status: 1, contractVersion: 4 },
      { appId: 200, status: 5, contractVersion: 4 },
    ];
    mockFetch.mockReturnValueOnce(jsonResponse(mockMarkets));

    const { parsed, isError } = await callTool(harness.client, "list_markets");
    expect(isError).toBe(false);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].appId).toBe(100);

    // Verify the fetch was called with the correct URL
    expect(mockFetch).toHaveBeenCalledWith(
      `${STUB_CONFIG.indexerUrl}/markets`,
      expect.anything()
    );
  });

  it("list_markets passes status filter", async () => {
    harness = await createSurfaceHarness();
    mockFetch.mockReturnValueOnce(jsonResponse([]));

    await callTool(harness.client, "list_markets", { status: 1 });

    expect(mockFetch).toHaveBeenCalledWith(
      `${STUB_CONFIG.indexerUrl}/markets?status=1`,
      expect.anything()
    );
  });

  it("get_market_trades passes limit param", async () => {
    harness = await createSurfaceHarness();
    mockFetch
      .mockReturnValueOnce(jsonResponse({ appId: 100, contractVersion: 4 }))
      .mockReturnValueOnce(jsonResponse([]));

    await callTool(harness.client, "get_market_trades", { app_id: 100, limit: 10 });

    expect(mockFetch).toHaveBeenCalledWith(
      `${STUB_CONFIG.indexerUrl}/markets/100/trades?limit=10`,
      expect.anything()
    );
  });

  it("get_price_history passes limit param", async () => {
    harness = await createSurfaceHarness();
    mockFetch
      .mockReturnValueOnce(jsonResponse({ appId: 100, contractVersion: 4 }))
      .mockReturnValueOnce(jsonResponse([]));

    await callTool(harness.client, "get_price_history", { app_id: 100, limit: 25 });

    expect(mockFetch).toHaveBeenCalledWith(
      `${STUB_CONFIG.indexerUrl}/markets/100/prices?limit=25`,
      expect.anything()
    );
  });

  it("get_positions calls correct path", async () => {
    harness = await createSurfaceHarness();
    mockFetch.mockReturnValueOnce(jsonResponse([]));

    await callTool(harness.client, "get_positions", { address: "A".repeat(58) });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining(`/users/${"A".repeat(58)}/positions`),
      expect.anything()
    );
  });

  it("get_market_positions calls correct path", async () => {
    harness = await createSurfaceHarness();
    mockFetch
      .mockReturnValueOnce(jsonResponse({ appId: 42, contractVersion: 4 }))
      .mockReturnValueOnce(jsonResponse([]));

    await callTool(harness.client, "get_market_positions", { app_id: 42 });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/markets/42/positions"),
      expect.anything()
    );
  });

  it("get_market rejects legacy contract versions", async () => {
    harness = await createSurfaceHarness();
    mockFetch.mockReturnValueOnce(jsonResponse({ appId: 42, status: 1, contractVersion: 2 }));

    const { parsed, isError } = await callTool(harness.client, "get_market", { app_id: 42 });
    expect(isError).toBe(true);
    expect(parsed.kind).toBe("validation");
    expect(parsed.error).toContain("contract version 2");
    expect(parsed.error).toContain("version 4+ markets only");
  });

  it("get_leaderboard calls correct path", async () => {
    harness = await createSurfaceHarness();
    mockFetch.mockReturnValueOnce(jsonResponse({ rows: [] }));

    const { parsed, isError } = await callTool(harness.client, "get_leaderboard");
    expect(isError).toBe(false);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/leaderboard"),
      expect.anything()
    );
  });

  it("indexer auth header is set when configured", async () => {
    harness = await createSurfaceHarness({ indexerAuth: "admin:secret" });
    mockFetch.mockReturnValueOnce(jsonResponse([]));

    await callTool(harness.client, "list_markets");

    const fetchCall = mockFetch.mock.calls[0];
    const headers = fetchCall[1]?.headers;
    expect(headers?.Authorization).toMatch(/^Basic /);
    expect(atob(headers.Authorization.replace("Basic ", ""))).toBe("admin:secret");
  });

  it("indexer auth header is absent when not configured", async () => {
    harness = await createSurfaceHarness({ indexerAuth: "" });
    mockFetch.mockReturnValueOnce(jsonResponse([]));

    await callTool(harness.client, "list_markets");

    const fetchCall = mockFetch.mock.calls[0];
    const headers = fetchCall[1]?.headers ?? {};
    expect(headers.Authorization).toBeUndefined();
  });

  it("indexer non-OK response returns structured error", async () => {
    harness = await createSurfaceHarness();
    mockFetch.mockReturnValueOnce(
      Promise.resolve(new Response("Not Found", { status: 404 }))
    );

    const { isError, parsed } = await callTool(harness.client, "list_markets");
    expect(isError).toBe(true);
    expect(parsed.error).toBeDefined();
  });

  it("indexer network failure returns structured error", async () => {
    harness = await createSurfaceHarness();
    mockFetch.mockRejectedValueOnce(new Error("fetch failed: ECONNREFUSED"));

    const { isError, parsed } = await callTool(harness.client, "list_markets");
    expect(isError).toBe(true);
    expect(parsed.kind).toBe("network");
  });
});
