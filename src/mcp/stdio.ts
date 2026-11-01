import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DaemonClient } from "../daemon/client.js";
import { buildMcpServer, type Toolset } from "./server.js";

/**
 * `wacon mcp` — what agents register as a stdio MCP server. It is a thin
 * shim: the daemon owns the actual WhatsApp socket, so any number of agents
 * can run this concurrently against the same session.
 */
export async function runStdioServer(opts: { toolset?: Toolset } = {}): Promise<void> {
  const client = new DaemonClient();
  const label = process.env.WACON_CLIENT_NAME ?? "stdio-agent";
  const server = buildMcpServer(client, label, opts);
  await server.connect(new StdioServerTransport());
}
