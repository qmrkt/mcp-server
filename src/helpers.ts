import algosdk from "algosdk";
import { compileResolutionBlueprint } from "@questionmarket/sdk/blueprints";
import type {
  MarketTemplateContext,
  ResolutionBlueprint,
} from "@questionmarket/sdk/blueprints";

// ---------------------------------------------------------------------------
// Text / error formatting
// ---------------------------------------------------------------------------

export function text(data: unknown) {
  const serialized =
    typeof data === "string"
      ? data
      : JSON.stringify(
          data,
          (_, v) => (typeof v === "bigint" ? v.toString() : v),
          2
        );
  return { content: [{ type: "text" as const, text: serialized }] };
}

export type ErrorKind = "validation" | "contract" | "network" | "rate_limit" | "internal";

export function errorResult(msg: string, kind: ErrorKind = "internal") {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: msg, kind, retry: kind === "network" }),
      },
    ],
    isError: true as const,
  };
}

function redactSensitiveText(raw: string): string {
  const redactedMnemonic = raw.replace(
    /\b(?:[a-z]+\s+){24}[a-z]+\b/gi,
    "[REDACTED_MNEMONIC]"
  );

  return redactedMnemonic
    .replace(/(mnemonic\s*[:=]\s*)([^\n]+)/gi, "$1[REDACTED]")
    .replace(/(secret(?:_?key)?\s*[:=]\s*)([^\n]+)/gi, "$1[REDACTED]")
    .replace(/(private(?:_?key)?\s*[:=]\s*)([^\n]+)/gi, "$1[REDACTED]");
}

export function classifyError(e: any): { message: string; kind: ErrorKind } {
  const raw = redactSensitiveText(e?.message || String(e ?? "unknown error"));

  if (/^(Default )?Blueprint\b/i.test(raw))
    return { message: raw.slice(0, 300), kind: "validation" };

  if (/^Unsupported market version:/i.test(raw))
    return { message: raw.slice(0, 300), kind: "validation" };

  if (/^Cannot .+: market \d+ is /i.test(raw))
    return { message: raw.slice(0, 300), kind: "validation" };

  if (/not found/i.test(raw) && /market|address/i.test(raw))
    return { message: raw.slice(0, 300), kind: "validation" };

  const avmMatch = raw.match(/logic eval error:\s*(.+?)(?:\. Details|$)/i);
  if (avmMatch) {
    return { message: avmMatch[1].slice(0, 300), kind: "contract" };
  }

  // Insufficient balance patterns
  if (/underflow|overspend|below min/i.test(raw))
    return { message: "Insufficient balance. Fund the account first.", kind: "validation" };

  // Network / connectivity
  if (/fetch failed|ECONNREFUSED|timeout|network|ENOTFOUND/i.test(raw))
    return { message: "Network error. Check connectivity and try again.", kind: "network" };

  // Rate limiting from faucet
  if (/rate limit/i.test(raw))
    return { message: raw.slice(0, 300), kind: "rate_limit" };

  // Status code errors from algod/indexer
  const statusMatch = raw.match(/status (\d+)/);
  if (statusMatch) {
    const code = Number(statusMatch[1]);
    if (code === 400) return { message: raw.slice(0, 300), kind: "validation" };
    if (code >= 500) return { message: "Server error. Try again.", kind: "network" };
  }

  return { message: raw.slice(0, 500), kind: "internal" };
}

/** Wrap a tool handler to catch errors, classify them, and return structured isError responses */
export function safe<T>(
  fn: (args: T) => Promise<ReturnType<typeof text>>,
  toolName?: string
): (
  args: T
) => Promise<ReturnType<typeof text> | ReturnType<typeof errorResult>> {
  return async (args: T) => {
    const start = performance.now();
    try {
      const result = await fn(args);
      const ms = (performance.now() - start).toFixed(0);
      console.error(`[mcp] ${toolName ?? "?"} ok ${ms}ms`);
      return result;
    } catch (e: any) {
      const ms = (performance.now() - start).toFixed(0);
      const { message, kind } = classifyError(e);
      console.error(`[mcp] ${toolName ?? "?"} ERR[${kind}] ${ms}ms: ${message}`);
      return errorResult(message, kind);
    }
  };
}

// ---------------------------------------------------------------------------
// Account helpers
// ---------------------------------------------------------------------------

export function getMnemonicAccount(
  mnemonic: string
): { addr: string; signer: algosdk.TransactionSigner } {
  const { addr, sk } = algosdk.mnemonicToSecretKey(mnemonic.trim());
  return {
    addr: addr.toString(),
    signer: algosdk.makeBasicAccountTransactionSigner({ addr, sk } as any),
  };
}

export function generateWallet(): { address: string; mnemonic: string } {
  const account = algosdk.generateAccount();
  return {
    address: account.addr.toString(),
    mnemonic: algosdk.secretKeyToMnemonic(account.sk),
  };
}

// ---------------------------------------------------------------------------
// Blueprint builder
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function buildDefaultAwaitSignalBlueprint(
  _question: string,
  _outcomes: string[]
): Uint8Array {
  return textEncoder.encode(
    JSON.stringify({
      id: "mcp-await-signal",
      version: 1,
      nodes: [
        {
          id: "review",
          type: "await_signal",
          config: {
            reason:
              "Question: {{market.question}}\n" +
              "Outcomes: {{market.outcomes.indexed}}\n\n" +
              "Return the correct outcome index with a short reason.",
            signal_type: "human_judgment.responded",
            timeout_seconds: 86400,
            required_payload: ["outcome", "reason"],
          },
        },
        {
          id: "success",
          type: "return",
          config: {
            value: {
              status: "success",
              outcome: "{{results.review.outcome}}",
              reason: "{{results.review.reason}}",
            },
          },
        },
        {
          id: "cancelled",
          type: "return",
          config: {
            value: {
              status: "cancelled",
              reason: "MCP await_signal review timed out",
            },
          },
        },
      ],
      edges: [
        {
          from: "review",
          to: "success",
          condition: "results.review.status == 'responded' && results.review.outcome != ''",
        },
        {
          from: "review",
          to: "cancelled",
          condition:
            "results.review.status == 'timeout' || results.review.status == 'cancelled'",
        },
      ],
    })
  );
}

export type CreateMarketBlueprintInput = unknown;

export function compileCreateMarketBlueprint(
  question: string,
  outcomes: string[],
  deadline: number,
  blueprintInput?: CreateMarketBlueprintInput
): { bytes: Uint8Array; source: "default" | "custom" } {
  const market: MarketTemplateContext = { question, outcomes, deadline };

  const blueprint =
    blueprintInput === undefined
      ? parseDefaultBlueprint(question, outcomes)
      : parseBlueprintInput(blueprintInput, "Blueprint");

  try {
    const compiled = compileResolutionBlueprint(blueprint, market);
    return {
      bytes: compiled.bytes,
      source: blueprintInput === undefined ? "default" : "custom",
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error ?? "unknown error");
    const prefix = blueprintInput === undefined ? "Default blueprint invalid" : "Blueprint invalid";
    throw new Error(`${prefix}: ${message}`);
  }
}

function parseDefaultBlueprint(
  question: string,
  outcomes: string[]
): ResolutionBlueprint {
  return JSON.parse(
    textDecoder.decode(buildDefaultAwaitSignalBlueprint(question, outcomes))
  ) as ResolutionBlueprint;
}

function parseBlueprintInput(
  blueprintInput: CreateMarketBlueprintInput,
  label: string
): ResolutionBlueprint {
  let parsed: unknown = blueprintInput;

  if (typeof blueprintInput === "string") {
    try {
      parsed = JSON.parse(blueprintInput);
    } catch {
      throw new Error(`${label} must be valid JSON.`);
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a blueprint JSON object.`);
  }

  const candidate = parsed as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.version !== "number" ||
    !Array.isArray(candidate.nodes) ||
    !Array.isArray(candidate.edges)
  ) {
    throw new Error(
      `${label} must include id, version, nodes, and edges.`
    );
  }

  return JSON.parse(JSON.stringify(parsed)) as ResolutionBlueprint;
}
