/**
 * Surface test harness: creates an MCP server+client pair via InMemoryTransport.
 * No real algod/indexer needed -- tests stub fetch and algod as needed.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createQuestionMarketServer, type ServerConfig } from "../../server.js";

/** Sensible defaults for surface tests (no real network calls expected) */
export const STUB_CONFIG: ServerConfig = {
  indexerUrl: "http://stub-indexer:9999",
  indexerAuth: "",
  indexerWriteToken: "",
  algodServer: "http://stub-algod",
  algodPort: 4001,
  algodToken: "a".repeat(64),
  kmdServer: "http://stub-kmd",
  kmdPort: 4002,
  kmdToken: "a".repeat(64),
  factoryAppId: 1003,
  protocolConfigAppId: 1002,
  usdcAsaId: 1001,
  agentMnemonic: "",
  faucetUrl: "http://stub-faucet:9999/faucet",
};

export type TestHarness = {
  client: Client;
  close: () => Promise<void>;
};

/** Create an isolated MCP server+client pair. Call close() when done. */
export async function createSurfaceHarness(
  configOverrides?: Partial<ServerConfig>
): Promise<TestHarness> {
  const config = { ...STUB_CONFIG, ...configOverrides };
  const { server } = createQuestionMarketServer(config);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "surface-test", version: "1.0" });
  await client.connect(clientTransport);
  return {
    client,
    close: () => client.close(),
  };
}

/** Call a tool and parse the JSON response. Returns { parsed, isError, raw }. */
export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<{ parsed: any; isError: boolean; raw: string }> {
  const result = await client.callTool({ name, arguments: args });
  const raw = (result.content as any)?.[0]?.text ?? "";
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = raw;
  }
  return { parsed, isError: !!result.isError, raw };
}
