import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { createSurfaceHarness, callTool, type TestHarness } from "./setup.js";

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

describe("write tools (mocked version gate)", () => {
  it("buy_shares rejects legacy contract versions before chain access", async () => {
    harness = await createSurfaceHarness();
    mockFetch.mockReturnValueOnce(jsonResponse({ appId: 42, status: 1, contractVersion: 2 }));

    const { parsed, isError } = await callTool(harness.client, "buy_shares", {
      app_id: 42,
      outcome_index: 0,
      max_cost_usdc: 5,
    });

    expect(isError).toBe(true);
    expect(parsed.kind).toBe("validation");
    expect(parsed.error).toContain("contract version 2");
    expect(parsed.error).toContain("buy_shares supports version 4+ markets only");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
