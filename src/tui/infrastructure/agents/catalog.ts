import { exec, execFile } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync, renameSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { AgentProtocol, DetectedAgent } from "../../domain/agent.js";
import type { AgentCatalogPort } from "../../application/ports.js";
import { needsShell, shellLine } from "./process.js";

/**
 * Which AI agents are installed, found the way desktop apps do it: a known
 * list of CLIs, looked up on PATH (with PATHEXT on Windows), each asked for
 * its version. `~/.wacon/agents.json` can add any other ACP agent:
 *
 *   [{ "id": "goose", "name": "Goose", "command": "goose", "protocol": "acp", "args": ["acp"] }]
 */

export interface AgentProfile {
  id: string;
  name: string;
  bin: string;
  protocol: AgentProtocol;
  /** Arguments that start the agent in ACP server mode. */
  acpArgs?: string[];
}

/** Ordered by how well each one does this job: tool use + Spanish + streaming. */
export const BUILTIN_AGENTS: readonly AgentProfile[] = [
  { id: "claude", name: "Claude Code", bin: "claude", protocol: "claude-stream" },
  { id: "codex", name: "Codex", bin: "codex", protocol: "codex-json" },
  { id: "gemini", name: "Gemini CLI", bin: "gemini", protocol: "acp", acpArgs: ["--acp"] },
  { id: "copilot", name: "GitHub Copilot", bin: "copilot", protocol: "acp", acpArgs: ["--acp"] },
  { id: "opencode", name: "OpenCode", bin: "opencode", protocol: "acp", acpArgs: ["acp"] },
  { id: "qwen", name: "Qwen Code", bin: "qwen", protocol: "acp", acpArgs: ["--acp"] },
  { id: "kimi", name: "Kimi Code", bin: "kimi", protocol: "acp", acpArgs: ["acp"] },
];

/** ACP launch arguments per agent id (built-in or user-defined). */
const acpArgsById = new Map<string, string[]>(BUILTIN_AGENTS.filter((a) => a.acpArgs).map((a) => [a.id, a.acpArgs!]));
export const acpArgsFor = (id: string): string[] => acpArgsById.get(id) ?? ["--acp"];

/**
 * First match on PATH. Inside each directory, PATHEXT order (.EXE before
 * .CMD) — a native binary beats an npm shim. Extension-less files are POSIX
 * shell scripts on Windows and cannot be spawned, so they are skipped there.
 */
export function findOnPath(bin: string, env: NodeJS.ProcessEnv = process.env, platform = process.platform): string | null {
  if (/[\\/]/.test(bin)) return existsSync(bin) ? bin : null;
  const dirs = (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : delimiter).filter(Boolean);
  const exts = platform === "win32" ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((e) => /^\.(exe|cmd|bat|com)$/i.test(e)) : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = join(dir, bin + ext.toLowerCase());
      try {
        if (statSync(p).isFile()) return p;
      } catch {
        // not here
      }
    }
  }
  return null;
}

export function parseVersion(out: string): string | null {
  return /\d+\.\d+(?:\.\d+)?(?:[-.][0-9a-z.]+)?/i.exec(out)?.[0] ?? null;
}

function versionOf(command: string): Promise<string | null> {
  return new Promise((resolve) => {
    const done = (_err: unknown, stdout?: string, stderr?: string) => resolve(parseVersion(`${stdout ?? ""}\n${stderr ?? ""}`));
    if (needsShell(command)) exec(shellLine(command, ["--version"]), { timeout: 8000, windowsHide: true }, done);
    else execFile(command, ["--version"], { timeout: 8000, windowsHide: true }, done);
  });
}

interface UserAgent {
  id?: unknown;
  name?: unknown;
  command?: unknown;
  protocol?: unknown;
  args?: unknown;
}

function userProfiles(file: string): AgentProfile[] {
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as UserAgent[];
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((a) => {
      if (typeof a.id !== "string" || !/^[a-z0-9-]{1,32}$/.test(a.id) || typeof a.command !== "string") return [];
      const protocol: AgentProtocol = a.protocol === "claude-stream" || a.protocol === "codex-json" ? a.protocol : "acp";
      const args = Array.isArray(a.args) && a.args.every((x) => typeof x === "string") ? (a.args as string[]) : undefined;
      if (protocol === "acp") acpArgsById.set(a.id, args ?? ["--acp"]);
      return [{ id: a.id, name: typeof a.name === "string" ? a.name : a.id, bin: a.command, protocol, acpArgs: args }];
    });
  } catch {
    return []; // a typo in a hand-edited file must not break the app
  }
}

const CACHE_TTL_MS = 24 * 3600_000;

export class LocalAgentCatalog implements AgentCatalogPort {
  constructor(
    private readonly home: string,
    private readonly now: () => number = Date.now
  ) {}

  async detect(force = false): Promise<DetectedAgent[]> {
    const cacheFile = join(this.home, "agents-cache.json");
    const profiles = mergeProfiles(BUILTIN_AGENTS, userProfiles(join(this.home, "agents.json")));
    if (!force) {
      const cached = this.readCache(cacheFile);
      // Trust the cache only while every cached binary still exists.
      if (cached && cached.every((a) => existsSync(a.command))) return cached.filter((a) => profiles.some((p) => p.id === a.id));
    }
    const found = await Promise.all(
      profiles.map(async (p): Promise<DetectedAgent | null> => {
        const command = findOnPath(p.bin);
        if (!command) return null;
        return { id: p.id, name: p.name, protocol: p.protocol, command, version: await versionOf(command) };
      })
    );
    const agents = found.filter((a): a is DetectedAgent => a !== null);
    this.writeCache(cacheFile, agents);
    return agents;
  }

  private readCache(file: string): DetectedAgent[] | null {
    try {
      const c = JSON.parse(readFileSync(file, "utf8")) as { at: number; agents: DetectedAgent[] };
      return this.now() - c.at < CACHE_TTL_MS && Array.isArray(c.agents) ? c.agents : null;
    } catch {
      return null;
    }
  }

  private writeCache(file: string, agents: DetectedAgent[]): void {
    try {
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ at: this.now(), agents }, null, 2));
      renameSync(tmp, file);
    } catch {
      // the cache is only a speed-up
    }
  }
}

function mergeProfiles(builtin: readonly AgentProfile[], user: AgentProfile[]): AgentProfile[] {
  const byId = new Map(builtin.map((p) => [p.id, p]));
  for (const u of user) byId.set(u.id, u);
  return [...byId.values()];
}
