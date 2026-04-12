/**
 * question.market MCP Server — entrypoint
 *
 * Reads env vars and deployment file, creates the server via factory,
 * connects to stdio transport.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { createQuestionMarketServer, type ServerConfig } from "./server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function loadDeployment(): Record<string, string> {
  for (const p of [
    path.resolve(__dirname, "../../sdk/protocol-deployment.json"),
    path.resolve(process.cwd(), "../sdk/protocol-deployment.json"),
  ]) {
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

const dep = loadDeployment();

const config: ServerConfig = {
  indexerUrl: process.env.INDEXER_URL || "https://question.market/api",
  indexerAuth: process.env.INDEXER_AUTH || "",
  indexerWriteToken: process.env.INDEXER_WRITE_TOKEN || "",
  algodServer: process.env.ALGOD_SERVER || "https://testnet-api.4160.nodely.dev",
  algodPort: Number(process.env.ALGOD_PORT || "443"),
  algodToken: process.env.ALGOD_TOKEN || "",
  kmdServer: process.env.KMD_SERVER || "http://localhost",
  kmdPort: Number(process.env.KMD_PORT || "4002"),
  kmdToken: process.env.KMD_TOKEN || "a".repeat(64),
  factoryAppId: Number(process.env.FACTORY_APP_ID || dep.FACTORY_APP_ID || "0"),
  protocolConfigAppId: Number(process.env.PROTOCOL_CONFIG_APP_ID || dep.PROTOCOL_CONFIG_APP_ID || "0"),
  usdcAsaId: Number(process.env.USDC_ASA_ID || dep.USDC_ASA_ID || "0"),
  agentMnemonic: process.env.AGENT_MNEMONIC || "",
  faucetUrl: process.env.FAUCET_URL || "https://question.market/api/faucet",
};

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  const { server } = createQuestionMarketServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcp] question.market MCP server v0.3.0");
  console.error(
    `[mcp] Indexer: ${config.indexerUrl}  Factory: ${config.factoryAppId}  USDC: ${config.usdcAsaId}`
  );
}

main().catch((err) => {
  console.error("[mcp] Fatal:", err);
  process.exit(1);
});
