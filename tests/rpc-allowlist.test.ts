import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The daemon only answers methods on its RPC allowlist, which lives apart
 * from WaconApi. Adding a client method without allowlisting it compiles
 * fine and fails only at runtime ("Unknown method") — this catches it.
 */
describe("daemon RPC allowlist", () => {
  it("covers every method DaemonClient calls", () => {
    const client = readFileSync(join(__dirname, "../src/daemon/client.ts"), "utf8");
    const server = readFileSync(join(__dirname, "../src/daemon/server.ts"), "utf8");
    const called = new Set([...client.matchAll(/this\.rpc(?:<[^>]*>)?\("(\w+)"/g)].map((m) => m[1]!));
    const allowBlock = /RPC_METHODS = new Set<keyof WaconApi>\(\[([\s\S]*?)\]\)/.exec(server)?.[1] ?? "";
    const allowed = new Set([...allowBlock.matchAll(/"(\w+)"/g)].map((m) => m[1]!));
    expect(called.size).toBeGreaterThan(10);
    expect([...called].filter((m) => !allowed.has(m))).toEqual([]);
  });
});
