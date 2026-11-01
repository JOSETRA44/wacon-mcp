// Run against an installed tarball, without linking or sending WhatsApp messages.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

if (!process.argv[2]) throw new Error("Usage: node scripts/smoke-package.mjs <installed-package-directory>");
const root = resolve(process.argv[2]);
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const cli = join(root, pkg.bin.wacon);
const home = mkdtempSync(join(tmpdir(), "wacon-package-"));
const env = Object.fromEntries(Object.entries({ ...process.env, WACON_HOME: home, WACON_SKIP_POSTINSTALL: "1" }).filter(([, value]) => value !== undefined));
const client = new Client({ name: "package-smoke", version: "1.0.0" });
let transport;
try {
  assert.equal(execFileSync(process.execPath, [cli, "--version"], { env, encoding: "utf8", timeout: 15000 }).trim(), pkg.version);
  assert.match(execFileSync(process.execPath, [cli, "--help"], { env, encoding: "utf8", timeout: 15000 }), /mcp/);
  for (const file of ["dist/daemon.js", "assets/stickers/cats/manifest.json", "skills/wacon-whatsapp/SKILL.md", "skills/wacon-knowledge/SKILL.md", "scripts/postinstall.mjs"]) {
    assert.ok(existsSync(join(root, file)), `Missing package asset: ${file}`);
  }
  const require = createRequire(join(root, "package.json"));
  const Database = require("better-sqlite3");
  const db = new Database(":memory:");
  try { assert.equal(db.prepare("SELECT 1 AS ok").get().ok, 1); } finally { db.close(); }

  transport = new StdioClientTransport({ command: process.execPath, args: [cli, "mcp"], env, stderr: "inherit" });
  await client.connect(transport, { timeout: 15000 });
  assert.equal(client.getServerVersion()?.version, pkg.version);
  const { tools } = await client.listTools({}, { timeout: 15000 });
  assert.ok(tools.some(tool => tool.name === "send_message"));
  assert.ok(tools.some(tool => tool.name === "read_messages"));
  assert.ok(tools.every(tool => tool.inputSchema.type === "object"));
  console.log(`${pkg.name}@${pkg.version}: CLI, native SQLite, assets and MCP handshake passed (${tools.length} tools).`);
} finally {
  await client.close();
  if (transport) await transport.close();
  rmSync(home, { recursive: true, force: true });
}
