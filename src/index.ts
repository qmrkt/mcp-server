#!/usr/bin/env node
/**
 * question.market MCP Server — entrypoint
 *
 * Reads env vars and deployment file, creates the server via factory,
 * connects to stdio transport.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createQuestionMarketServer, type ServerConfig } from "./server.js";
import { MCP_SERVER_VERSION } from "./version.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function deploymentCandidatePaths(searchRoot: string): string[] {
  return [
    path.resolve(searchRoot, "protocol-deployment.json"),
    path.resolve(searchRoot, "sdk/protocol-deployment.json"),
    path.resolve(searchRoot, "../sdk/protocol-deployment.json"),
    path.resolve(searchRoot, "../question/sdk/protocol-deployment.json"),
    path.resolve(searchRoot, "../question-sdk/protocol-deployment.json"),
  ];
}

export type NetworkId = "localnet" | "testnet" | "mainnet";

export function resolveNetwork(env: NodeJS.ProcessEnv = process.env): NetworkId {
  const explicit = (env.QUESTION_MARKET_NETWORK || env.ALGORAND_NETWORK || "").toLowerCase();
  if (explicit === "localnet" || explicit === "testnet" || explicit === "mainnet") {
    return explicit;
  }
  const server = (env.ALGOD_SERVER || "https://testnet-api.4160.nodely.dev").toLowerCase();
  if (server.includes("localhost") || server.includes("127.0.0.1") || server.includes("sandbox")) {
    return "localnet";
  }
  if (server.includes("mainnet")) return "mainnet";
  return "testnet";
}

function bundledDeploymentPath(network: NetworkId): string {
  return path.resolve(__dirname, "deployments", `${network}.json`);
}

export function loadDeployment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const network = resolveNetwork(env);
  const roots = [
    path.resolve(__dirname, ".."),
    process.cwd(),
    path.resolve(process.cwd(), ".."),
  ];
  const explicitPath = env.QUESTION_MARKET_DEPLOYMENT_PATH || env.QUESTION_MARKET_DEPLOYMENT_OUT;

  // Explicit env-var override is trusted regardless of its `network` field.
  if (explicitPath) {
    const d = readDeployment(path.resolve(explicitPath));
    if (d) return d;
  }

  // For testnet and mainnet, prefer the deployment bundled with the npm package
  // so stray localnet `protocol-deployment.json` files in parent directories do
  // not poison the config.
  if (network !== "localnet") {
    const d = readDeployment(bundledDeploymentPath(network), network);
    if (d) return d;
  }

  // Monorepo / local-checkout fallbacks, filtered by the network the server
  // was resolved to. Order: tmpdir localnet cache, sibling sdk/ folders.
  const fallbacks = [
    path.join(os.tmpdir(), "question-sdk-localnet-deployment.json"),
    ...roots.flatMap(deploymentCandidatePaths),
  ];
  for (const p of fallbacks) {
    const d = readDeployment(p, network);
    if (d) return d;
  }

  // Last-ditch: bundled for localnet, or empty.
  if (network === "localnet") {
    const d = readDeployment(bundledDeploymentPath(network), network);
    if (d) return d;
  }
  return {};
}

function readDeployment(p: string, expectedNetwork?: NetworkId): Record<string, string> | null {
  try {
    const d = JSON.parse(fs.readFileSync(p, "utf8"));
    if (expectedNetwork && d.network && d.network !== expectedNetwork) {
      return null;
    }
    return {
      FACTORY_APP_ID: String(d.marketFactoryAppId ?? ""),
      PROTOCOL_CONFIG_APP_ID: String(d.protocolConfigAppId ?? ""),
      USDC_ASA_ID: String(d.usdcAsaId ?? ""),
    };
  } catch {
    return null;
  }
}

export function createRuntimeConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const dep = loadDeployment(env);

  return {
    indexerUrl: env.INDEXER_URL || "https://question.market/api",
    indexerAuth: env.INDEXER_AUTH || "",
    indexerWriteToken: env.INDEXER_WRITE_TOKEN || "",
    algodServer: env.ALGOD_SERVER || "https://testnet-api.4160.nodely.dev",
    algodPort: Number(env.ALGOD_PORT || "443"),
    algodToken: env.ALGOD_TOKEN || "",
    kmdServer: env.KMD_SERVER || "http://localhost",
    kmdPort: Number(env.KMD_PORT || "4002"),
    kmdToken: env.KMD_TOKEN || "a".repeat(64),
    factoryAppId: Number(env.FACTORY_APP_ID || dep.FACTORY_APP_ID || "0"),
    protocolConfigAppId: Number(env.PROTOCOL_CONFIG_APP_ID || dep.PROTOCOL_CONFIG_APP_ID || "0"),
    usdcAsaId: Number(env.USDC_ASA_ID || dep.USDC_ASA_ID || "0"),
    agentMnemonic: env.AGENT_MNEMONIC || "",
    faucetUrl: env.FAUCET_URL || "https://question.market/api/faucet",
  };
}

function startupWarnings(config: ServerConfig): string[] {
  const warnings: string[] = [];

  if (config.usdcAsaId <= 0) {
    warnings.push(
      "USDC_ASA_ID is not configured. Trading, LP, claims, refunds, and USDC-aware balances are disabled."
    );
  }

  if (config.usdcAsaId > 0 && (config.factoryAppId <= 0 || config.protocolConfigAppId <= 0)) {
    warnings.push(
      "FACTORY_APP_ID and PROTOCOL_CONFIG_APP_ID are required to enable create_market outside the monorepo."
    );
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export async function main(config: ServerConfig = createRuntimeConfig()) {
  const { server } = createQuestionMarketServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[mcp] question.market MCP server v${MCP_SERVER_VERSION}`);
  console.error(
    `[mcp] Network: ${resolveNetwork()}  Indexer: ${config.indexerUrl}  Factory: ${config.factoryAppId}  USDC: ${config.usdcAsaId}`
  );
  for (const warning of startupWarnings(config)) {
    console.error(`[mcp] ${warning}`);
  }
}

function isExecutedDirectly(): boolean {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isExecutedDirectly()) {
  main().catch((err) => {
    console.error("[mcp] Fatal:", err);
    process.exit(1);
  });
}
