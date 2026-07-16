import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Store } from "../core/store.js";
import { WhatsAppConnection } from "../core/connection.js";
import { WaconService } from "../core/service.js";
import { loadConfig } from "../core/config.js";
import { localApi, type WaconApi } from "../mcp/api.js";
import { buildMcpServer } from "../mcp/server.js";
import { writeDaemonInfo, clearDaemonInfo, newToken } from "./lifecycle.js";
import { ensureDirs } from "../core/paths.js";

const RPC_METHODS = new Set<keyof WaconApi>([
  "status",
  "qr",
  "listChats",
  "readMessages",
  "searchMessages",
  "searchContacts",
  "recall",
  "listEpisodes",
  "readEpisode",
  "summarizeEpisode",
  "groupInfo",
  "send",
  "getProfile",
  "observe",
  "analyzeContact",
  "getPersona",
  "initAll",
  "logout",
]);

export async function runDaemon(): Promise<void> {
  ensureDirs();
  const config = loadConfig();
  const store = new Store();
  const connection = new WhatsAppConnection(store);
  const service = new WaconService(store, connection);
  const api = localApi(service);
  const token = newToken();

  const app = express();
  app.use(express.json({ limit: "2mb" }));

  // Health is intentionally public (loopback-only anyway): the spawner needs
  // it to detect a live daemon even when its token file is stale.
  app.get("/health", (_req, res) => {
    res.json({ ok: true, state: connection.state, pid: process.pid });
  });

  app.use((req, res, next) => {
    const header = req.headers.authorization ?? "";
    const provided = header.startsWith("Bearer ") ? header.slice(7) : (req.headers["x-wacon-token"] as string | undefined);
    if (provided !== token) {
      res.status(401).json({ error: "Invalid or missing Wacon token. Read it from ~/.wacon/daemon.json" });
      return;
    }
    next();
  });

  /**
   * Single RPC surface: { method: keyof WaconApi, args: unknown[] }.
   * Tool-level input validation happens in the MCP layer; the CLI passes
   * already-typed values. The whitelist prevents calling anything else.
   */
  app.post("/rpc", (req, res) => {
    void (async () => {
      const { method, args } = req.body as { method?: string; args?: unknown[] };
      if (!method || !RPC_METHODS.has(method as keyof WaconApi)) {
        res.status(400).json({ error: `Unknown method: ${method}` });
        return;
      }
      try {
        const fn = api[method as keyof WaconApi] as (...a: unknown[]) => Promise<unknown>;
        const result = await fn(...(args ?? []));
        res.json({ result: result ?? null });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    })();
  });

  // MCP over Streamable HTTP (stateless): any local agent can connect to
  // http://127.0.0.1:<port>/mcp with the Bearer token from daemon.json.
  app.post("/mcp", (req, res) => {
    void (async () => {
      const mcpServer = buildMcpServer(api, "http-agent");
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void mcpServer.close();
      });
      try {
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (err) {
        if (!res.headersSent) {
          res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        }
      }
    })();
  });
  app.get("/mcp", (_req, res) => {
    res.status(405).json({ error: "Stateless MCP server: use POST" });
  });

  const port = config.daemonPort;
  await new Promise<void>((resolve, reject) => {
    const server = app.listen(port, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });

  writeDaemonInfo({ port, token, pid: process.pid, startedAt: new Date().toISOString() });
  console.log(`[wacon] daemon listening on 127.0.0.1:${port}`);

  const shutdown = async () => {
    clearDaemonInfo();
    await connection.stop().catch(() => undefined);
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  const indexed = store.backfillVectors();
  if (indexed > 0) console.log(`[wacon] memory index: vectorized ${indexed} messages`);

  await connection.start();
  console.log(`[wacon] whatsapp connection started (state: ${connection.state})`);
}
