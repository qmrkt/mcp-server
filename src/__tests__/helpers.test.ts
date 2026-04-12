import { describe, it, expect, vi } from "vitest";
import {
  text,
  errorResult,
  classifyError,
  safe,
  getMnemonicAccount,
  generateWallet,
  buildDefaultHumanJudgeBlueprint,
  compileCreateMarketBlueprint,
} from "../helpers.js";
import type { ResolutionBlueprint } from "@questionmarket/sdk/blueprints";

// ---------------------------------------------------------------------------
// text()
// ---------------------------------------------------------------------------

describe("text", () => {
  it("wraps a string directly", () => {
    const result = text("hello");
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toBe("hello");
  });

  it("serializes objects as JSON", () => {
    const result = text({ a: 1, b: "two" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({ a: 1, b: "two" });
  });

  it("handles bigint values", () => {
    const result = text({ amount: 10_000_000n });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.amount).toBe("10000000");
  });

  it("handles nested bigints", () => {
    const result = text({ outer: { inner: 999n } });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.outer.inner).toBe("999");
  });

  it("handles null and undefined", () => {
    const result = text(null);
    expect(result.content[0].text).toBe("null");
  });

  it("handles arrays", () => {
    const result = text([1, 2, 3]);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual([1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// errorResult()
// ---------------------------------------------------------------------------

describe("errorResult", () => {
  it("sets isError flag", () => {
    const result = errorResult("something broke");
    expect(result.isError).toBe(true);
  });

  it("defaults to internal kind", () => {
    const result = errorResult("unknown error");
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.kind).toBe("internal");
    expect(parsed.retry).toBe(false);
  });

  it("sets retry true for network errors", () => {
    const result = errorResult("connection failed", "network");
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.kind).toBe("network");
    expect(parsed.retry).toBe(true);
  });

  it("includes error message", () => {
    const result = errorResult("bad input", "validation");
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("bad input");
    expect(parsed.kind).toBe("validation");
  });
});

// ---------------------------------------------------------------------------
// classifyError()
// ---------------------------------------------------------------------------

describe("classifyError", () => {
  it("extracts AVM logic eval errors", () => {
    const err = new Error(
      "TransactionPool.Remember: transaction ABC: logic eval error: assert failed. Details: pc=123"
    );
    const { message, kind } = classifyError(err);
    expect(kind).toBe("contract");
    expect(message).toBe("assert failed");
  });

  it("classifies underflow as validation", () => {
    const { kind, message } = classifyError(new Error("underflow on subtraction"));
    expect(kind).toBe("validation");
    expect(message).toContain("Insufficient balance");
  });

  it("classifies overspend as validation", () => {
    const { kind } = classifyError(new Error("overspend: account balance below min"));
    expect(kind).toBe("validation");
  });

  it("classifies below min as validation", () => {
    const { kind } = classifyError(new Error("account balance below min required"));
    expect(kind).toBe("validation");
  });

  it("classifies fetch failed as network", () => {
    const { kind, message } = classifyError(new TypeError("fetch failed"));
    expect(kind).toBe("network");
    expect(message).toContain("Network error");
  });

  it("classifies ECONNREFUSED as network", () => {
    const { kind } = classifyError(new Error("connect ECONNREFUSED 127.0.0.1:4001"));
    expect(kind).toBe("network");
  });

  it("classifies timeout as network", () => {
    const { kind } = classifyError(new Error("Request timeout after 30000ms"));
    expect(kind).toBe("network");
  });

  it("classifies ENOTFOUND as network", () => {
    const { kind } = classifyError(new Error("getaddrinfo ENOTFOUND testnet-api.example.com"));
    expect(kind).toBe("network");
  });

  it("classifies rate limit errors", () => {
    const { kind } = classifyError(new Error("Rate limited. Try again in 45 minutes."));
    expect(kind).toBe("rate_limit");
  });

  it("classifies HTTP 400 as validation", () => {
    const { kind } = classifyError(new Error("Received status 400 (Bad Request)"));
    expect(kind).toBe("validation");
  });

  it("classifies HTTP 500 as network (retryable)", () => {
    const { kind } = classifyError(new Error("Received status 500 (Internal Server Error)"));
    expect(kind).toBe("network");
  });

  it("classifies HTTP 503 as network", () => {
    const { kind } = classifyError(new Error("Received status 503 (Service Unavailable)"));
    expect(kind).toBe("network");
  });

  it("falls back to internal for unknown errors", () => {
    const { kind, message } = classifyError(new Error("something completely unexpected"));
    expect(kind).toBe("internal");
    expect(message).toBe("something completely unexpected");
  });

  it("handles non-Error objects", () => {
    const { kind, message } = classifyError("a plain string error");
    expect(kind).toBe("internal");
    expect(message).toBe("a plain string error");
  });

  it("handles errors without message", () => {
    const { kind } = classifyError({});
    expect(kind).toBe("internal");
  });

  it("truncates long internal errors to 500 chars", () => {
    const longMsg = "x".repeat(1000);
    const { message } = classifyError(new Error(longMsg));
    expect(message.length).toBe(500);
  });

  it("truncates long rate limit errors to 300 chars", () => {
    const longMsg = "Rate limited " + "x".repeat(500);
    const { message } = classifyError(new Error(longMsg));
    expect(message.length).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// safe()
// ---------------------------------------------------------------------------

describe("safe", () => {
  it("returns result on success", async () => {
    const handler = safe(async () => text({ ok: true }), "test");
    const result = await handler({});
    expect(result.content[0].text).toContain('"ok"');
    expect("isError" in result).toBe(false);
  });

  it("catches errors and returns isError", async () => {
    const handler = safe(async () => {
      throw new Error("boom");
    }, "test");
    const result = await handler({});
    expect("isError" in result && result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("boom");
  });

  it("classifies thrown AVM errors", async () => {
    const handler = safe(async () => {
      throw new Error("logic eval error: assert failed. Details: pc=456");
    }, "test");
    const result = await handler({});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.kind).toBe("contract");
    expect(parsed.error).toBe("assert failed");
  });

  it("classifies thrown network errors as retryable", async () => {
    const handler = safe(async () => {
      throw new TypeError("fetch failed");
    }, "test");
    const result = await handler({});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.kind).toBe("network");
    expect(parsed.retry).toBe(true);
  });

  it("never throws, even with bizarre errors", async () => {
    const handler = safe(async () => {
      throw undefined;
    }, "test");
    const result = await handler({});
    expect("isError" in result && result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getMnemonicAccount()
// ---------------------------------------------------------------------------

describe("getMnemonicAccount", () => {
  const TEST_MNEMONIC =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon invest";

  it("returns a valid address", () => {
    const { addr } = getMnemonicAccount(TEST_MNEMONIC);
    expect(addr).toHaveLength(58);
  });

  it("returns a signer function", () => {
    const { signer } = getMnemonicAccount(TEST_MNEMONIC);
    expect(typeof signer).toBe("function");
  });

  it("trims whitespace from mnemonic", () => {
    const { addr: a } = getMnemonicAccount(TEST_MNEMONIC);
    const { addr: b } = getMnemonicAccount(`  ${TEST_MNEMONIC}  `);
    expect(a).toBe(b);
  });

  it("throws on invalid mnemonic", () => {
    expect(() => getMnemonicAccount("not a valid mnemonic")).toThrow();
  });

  it("produces deterministic address", () => {
    const { addr: a } = getMnemonicAccount(TEST_MNEMONIC);
    const { addr: b } = getMnemonicAccount(TEST_MNEMONIC);
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// generateWallet()
// ---------------------------------------------------------------------------

describe("generateWallet", () => {
  it("returns a 58-char address", () => {
    const { address } = generateWallet();
    expect(address).toHaveLength(58);
  });

  it("returns a 25-word mnemonic", () => {
    const { mnemonic } = generateWallet();
    expect(mnemonic.split(" ")).toHaveLength(25);
  });

  it("generates unique addresses", () => {
    const a = generateWallet();
    const b = generateWallet();
    expect(a.address).not.toBe(b.address);
  });

  it("mnemonic round-trips back to same address", () => {
    const { address, mnemonic } = generateWallet();
    const { addr } = getMnemonicAccount(mnemonic);
    expect(addr).toBe(address);
  });
});

// ---------------------------------------------------------------------------
// buildDefaultHumanJudgeBlueprint()
// ---------------------------------------------------------------------------

describe("buildDefaultHumanJudgeBlueprint", () => {
  it("returns valid JSON as Uint8Array", () => {
    const result = buildDefaultHumanJudgeBlueprint("Will it rain?", ["Yes", "No"]);
    expect(result).toBeInstanceOf(Uint8Array);
    const parsed = JSON.parse(new TextDecoder().decode(result));
    expect(parsed.id).toBe("mcp-human-judge");
    expect(parsed.version).toBe(1);
  });

  it("includes outcome template token in the prompt", () => {
    const result = buildDefaultHumanJudgeBlueprint("Test?", ["A", "B", "C"]);
    const parsed = JSON.parse(new TextDecoder().decode(result));
    const prompt = parsed.nodes[0].config.prompt;
    expect(prompt).toContain("{{market.outcomes.indexed}}");
  });

  it("has three nodes: judge, submit, cancel", () => {
    const result = buildDefaultHumanJudgeBlueprint("Q?", ["Yes", "No"]);
    const parsed = JSON.parse(new TextDecoder().decode(result));
    expect(parsed.nodes).toHaveLength(3);
    expect(parsed.nodes.map((n: any) => n.id)).toEqual(["judge", "submit", "cancel"]);
  });

  it("has two edges", () => {
    const result = buildDefaultHumanJudgeBlueprint("Q?", ["Yes", "No"]);
    const parsed = JSON.parse(new TextDecoder().decode(result));
    expect(parsed.edges).toHaveLength(2);
    expect(parsed.edges[0].from).toBe("judge");
    expect(parsed.edges[0].to).toBe("submit");
    expect(parsed.edges[1].to).toBe("cancel");
  });

  it("includes question token in prompt for compile-time substitution", () => {
    const result = buildDefaultHumanJudgeBlueprint("Will BTC hit 100K?", ["Yes", "No"]);
    const parsed = JSON.parse(new TextDecoder().decode(result));
    expect(parsed.nodes[0].config.prompt).toContain("{{market.question}}");
    expect(parsed.nodes[0].config.prompt).toContain("{{market.outcomes.indexed}}");
  });
});

// ---------------------------------------------------------------------------
// compileCreateMarketBlueprint()
// ---------------------------------------------------------------------------

describe("compileCreateMarketBlueprint", () => {
  const customBlueprint: ResolutionBlueprint = {
    id: "custom-human-judge",
    version: 1,
    nodes: [
      {
        id: "judge",
        type: "human_judge",
        position: { x: 0, y: 0 },
        config: {
          prompt:
            "Question: {{market.question}}\nOutcomes: {{market.outcomes.indexed}}\n\nSelect the correct outcome.",
          allowed_responders: ["creator"],
          timeout_seconds: 3600,
        },
      },
      {
        id: "submit",
        type: "submit_result",
        position: { x: 320, y: 0 },
        config: {
          outcome_key: "judge.outcome",
        },
      },
    ],
    edges: [{ from: "judge", to: "submit", condition: "judge.status == 'responded'" }],
  };

  it("uses the default MCP blueprint when none is provided", () => {
    const result = compileCreateMarketBlueprint(
      "Will it rain?",
      ["Yes", "No"],
      1_746_384_000
    );
    expect(result.source).toBe("default");

    const parsed = JSON.parse(new TextDecoder().decode(result.bytes));
    expect(parsed.nodes).toHaveLength(3);
    expect(parsed.nodes[0].config.prompt).toContain("Will it rain?");
  });

  it("accepts a custom blueprint object and compiles template tokens", () => {
    const result = compileCreateMarketBlueprint(
      "Will BTC hit 100K?",
      ["Yes", "No"],
      1_746_384_000,
      customBlueprint
    );
    expect(result.source).toBe("custom");

    const parsed = JSON.parse(new TextDecoder().decode(result.bytes));
    expect(parsed.nodes[0].config.prompt).toContain("Will BTC hit 100K?");
    expect(parsed.nodes[0].config.prompt).toContain("0: Yes, 1: No");
    expect(parsed.nodes[0].position).toBeUndefined();
  });

  it("accepts a custom blueprint JSON string", () => {
    const result = compileCreateMarketBlueprint(
      "Test question?",
      ["A", "B"],
      1_746_384_000,
      JSON.stringify(customBlueprint)
    );
    expect(result.source).toBe("custom");
    expect(result.bytes).toBeInstanceOf(Uint8Array);
  });

  it("rejects invalid blueprint JSON strings", () => {
    expect(() =>
      compileCreateMarketBlueprint(
        "Test question?",
        ["A", "B"],
        1_746_384_000,
        "{"
      )
    ).toThrow("Blueprint must be valid JSON.");
  });

  it("rejects blueprints missing required structure", () => {
    expect(() =>
      compileCreateMarketBlueprint(
        "Test question?",
        ["A", "B"],
        1_746_384_000,
        { nodes: [], edges: [] }
      )
    ).toThrow("Blueprint must include id, version, nodes, and edges.");
  });

  it("rejects blueprints that fail frontend validation", () => {
    expect(() =>
      compileCreateMarketBlueprint(
        "Test question?",
        ["A", "B"],
        1_746_384_000,
        {
          id: "invalid-submit",
          version: 1,
          nodes: [{ id: "submit", type: "submit_result", config: {} }],
          edges: [],
        }
      )
    ).toThrow('Blueprint invalid: Node "submit" needs an outcome source.');
  });

  it("redacts mnemonic material from classified errors", () => {
    const mnemonic =
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon invest";
    const { kind, message } = classifyError(new Error(`wallet failure mnemonic=${mnemonic}`));
    expect(kind).toBe("internal");
    expect(message).toContain("[REDACTED");
    expect(message).not.toContain(mnemonic);
  });
});
