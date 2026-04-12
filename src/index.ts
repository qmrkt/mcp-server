#!/usr/bin/env node
/**
 * question.market MCP Server — entrypoint
 *
 * Reads env vars and deployment file, creates the server via factory,
 * connects to stdio transport.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as fs from "node:fs";
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

export function loadDeployment(): Record<string, string> {
  const roots = [
    path.resolve(__dirname, ".."),
    process.cwd(),
    path.resolve(process.cwd(), ".."),
  ];

  const candidates = Array.from(new Set(roots.flatMap(deploymentCandidatePaths)));

  for (const p of candidates) {
    try {
      const d = JSON.parse(fs.readFileSync(p, "utf8"));
      return {
        FACTORY_APP_ID: String(d.marketFactoryAppId ?? ""),
        PROTOCOL_CONFIG_APP_ID: String(d.protocolConfigAppId ?? ""),
        USDC_ASA_ID: String(d.usdcAsaId ?? ""),
      };
    } catch {}
  }
  return {};
}

export function createRuntimeConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const dep = loadDeployment();

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
    pinataJwt: env.PINATA_JWT || "",
    pinataGateway: env.PINATA_GATEWAY || "",
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

  if (!config.pinataJwt) {
    warnings.push(
      "PINATA_JWT is not configured. set_market_image is disabled and create_market image uploads will be skipped."
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
    `[mcp] Indexer: ${config.indexerUrl}  Factory: ${config.factoryAppId}  USDC: ${config.usdcAsaId}`
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
