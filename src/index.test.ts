import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Minimal test server to verify MCP tool registration works
function createTestServer() {
  const server = new McpServer({ name: "test", version: "0.1.0" });

  server.tool(
    "list_markets",
    "List markets",
    { status: z.number().optional() },
    async () => ({
      content: [{ type: "text" as const, text: "[]" }],
    })
  );

  server.tool(
    "get_market",
    "Get a market",
    { app_id: z.number() },
    async ({ app_id }) => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ appId: app_id, status: 1 }),
        },
      ],
    })
  );

  return server;
}

describe("MCP server", () => {
  it("registers tools and responds to list_tools", async () => {
    const server = createTestServer();
    const [
      clientTransport,
      serverTransport,
    ] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "1.0" });
    await client.connect(clientTransport);

    const result = await client.listTools();
    const toolNames = result.tools.map((t: any) => t.name);

    expect(toolNames).toContain("list_markets");
    expect(toolNames).toContain("get_market");

    await client.close();
  });

  it("calls list_markets tool", async () => {
    const server = createTestServer();
    const [
      clientTransport,
      serverTransport,
    ] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "1.0" });
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "list_markets",
      arguments: {},
    });
    expect(result.content).toBeDefined();
    expect((result.content as any)[0].text).toBe("[]");

    await client.close();
  });

  it("calls get_market tool with app_id", async () => {
    const server = createTestServer();
    const [
      clientTransport,
      serverTransport,
    ] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "1.0" });
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "get_market",
      arguments: { app_id: 1234 },
    });
    const text = (result.content as any)[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.appId).toBe(1234);
    expect(parsed.status).toBe(1);

    await client.close();
  });

  it("real create_market tool uses the atomic multi-outcome create path", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "server.ts"), "utf8");
    expect(src).toContain("createMarketAtomic");
    expect(src).toContain("compileCreateMarketBlueprint");
    expect(src).toContain(".min(2)");
    expect(src).toContain(".max(MAX_ACTIVE_LP_OUTCOMES)");
    expect(src).not.toContain("await bootstrap(");
    expect(src).not.toContain("const fundFactoryTxn");
  });

  it("documents and registers get_current_holdings", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "server.ts"), "utf8");
    expect(src).toContain('"get_current_holdings"');
    expect(src).toContain("getCurrentHoldings(address)");
  });
});
