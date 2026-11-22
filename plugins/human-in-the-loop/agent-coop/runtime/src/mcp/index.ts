// The agent-coop MCP shim: a stdio MCP server whose every tool is one HTTP call to
// the single writer process (repo-design §Single writer process, R4).
//
// Run with `bun run src/mcp/index.ts` — never `bun build --compile`, which
// breaks the MCP SDK's subpath imports (D19).
//
// It holds no SQLite handle, no Yjs doc, and imports nothing but contract
// types and the pure mapping table in `tools.ts`.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { contract_version } from "../contract/index.ts";
import { callTool, TOOLS, type Fetcher } from "./tools.ts";

/** localhost only in v1; remote access is A12, deferred. */
export function baseUrl(): string {
  const explicit = process.env.AGENT_COOP_URL;
  if (explicit !== undefined && explicit.length > 0) return explicit.replace(/\/$/, "");
  return `http://localhost:${process.env.AGENT_COOP_PORT ?? 4317}`;
}

/** A tool result is always JSON text: the endpoint body, or an `McpToolError`. */
function textResult(value: unknown, isError: boolean) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    isError,
  };
}

export function createMcpServer(url = baseUrl(), fetcher?: Fetcher): McpServer {
  const server = new McpServer({ name: "agent-coop", version: contract_version });

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.input },
      async (args: unknown) => {
        const result = await callTool(url, tool.name, args, fetcher);
        return result.ok ? textResult(result.value, false) : textResult(result.error, true);
      },
    );
  }

  return server;
}

export async function main(): Promise<void> {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
}

if (import.meta.main) await main();

export * from "./tools.ts";
