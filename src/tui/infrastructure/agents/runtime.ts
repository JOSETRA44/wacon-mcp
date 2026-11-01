import { execFile } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { AgentEvent, DetectedAgent, ModelOption } from "../../domain/agent.js";
import type { AgentRuntimePort, AgentSession, AgentSessionOptions, ModelList } from "../../application/ports.js";
import { AcpSession } from "./acp-runtime.js";
import { ClaudeSession, CodexSession } from "./stream-runtimes.js";
import { acpArgsFor } from "./catalog.js";

/**
 * Claude Code takes model aliases that always point at the latest of each
 * family — the stable way to offer a choice without hard-coding versions.
 */
export const CLAUDE_MODELS: ModelOption[] = [
  { id: "sonnet", name: "Sonnet", description: "equilibrio entre rapidez y calidad" },
  { id: "opus", name: "Opus", description: "el más capaz, más lento y costoso" },
  { id: "fable", name: "Fable", description: "el más nuevo de Anthropic" },
  { id: "haiku", name: "Haiku", description: "el más rápido y barato" },
];

/** `codex debug models` → its catalog (minus internal helper models). */
export function parseCodexModels(json: string): ModelOption[] {
  try {
    const j = JSON.parse(json) as { models?: { slug?: string; display_name?: string; description?: string; visibility?: string }[] };
    return (j.models ?? [])
      .filter((m) => m.slug && m.visibility !== "hide" && !/auto-review/.test(m.slug))
      .map((m) => ({ id: m.slug!, name: m.display_name ?? m.slug!, ...(m.description ? { description: m.description } : {}) }));
  } catch {
    return [];
  }
}

/** Picks the adapter for each agent's protocol. */
export class AgentRuntime implements AgentRuntimePort {
  private cache = new Map<string, ModelList>();

  /**
   * `cacheFile` keeps model lists for a day: some agents take a while to
   * answer (OpenCode lists 100+ models in ~35 s), the picker should not.
   */
  constructor(private readonly cacheFile: string | null = null) {
    if (!cacheFile) return;
    try {
      const c = JSON.parse(readFileSync(cacheFile, "utf8")) as { at: number; lists: Record<string, ModelList> };
      if (Date.now() - c.at < 24 * 3600_000) for (const [k, v] of Object.entries(c.lists ?? {})) this.cache.set(k, v);
    } catch {
      // no cache yet
    }
  }

  private remember(agentId: string, list: ModelList): void {
    this.cache.set(agentId, list);
    if (!this.cacheFile) return;
    try {
      const tmp = `${this.cacheFile}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ at: Date.now(), lists: Object.fromEntries(this.cache) }));
      renameSync(tmp, this.cacheFile);
    } catch {
      // a speed-up only
    }
  }

  open(agent: DetectedAgent, opts: AgentSessionOptions, onEvent: (e: AgentEvent) => void): AgentSession {
    switch (agent.protocol) {
      case "claude-stream":
        return new ClaudeSession(agent, opts, onEvent);
      case "codex-json":
        return new CodexSession(agent, opts, onEvent);
      default:
        return new AcpSession(agent, acpLaunchArgs(agent, opts), opts, (e) => {
          // Keep what the agent reports, so the picker is instant next time.
          if (e.type === "models" && e.models.length) this.remember(agent.id, { models: e.models, current: e.current });
          onEvent(e);
        });
    }
  }

  async models(agent: DetectedAgent, opts: AgentSessionOptions): Promise<ModelList> {
    const hit = this.cache.get(agent.id);
    if (hit) return hit;
    let list: ModelList;
    if (agent.protocol === "claude-stream") list = { models: CLAUDE_MODELS, current: null };
    else if (agent.protocol === "codex-json") list = { models: parseCodexModels(await run(agent.command, ["debug", "models"])), current: null };
    else list = await probeAcp(agent, opts);
    if (list.models.length) this.remember(agent.id, list);
    return list;
  }
}

/**
 * ACP launch line. Copilot does not attach the MCP servers sent in
 * session/new (it answered "no tengo la herramienta wacon"), so Wacon goes in
 * through its own flag; "solo Wacon" also drops its built-in servers.
 */
export function acpLaunchArgs(agent: DetectedAgent, opts: AgentSessionOptions): string[] {
  const base = acpArgsFor(agent.id);
  if (agent.id !== "copilot") return base;
  const wacon = JSON.stringify({ mcpServers: { wacon: { type: "local", command: opts.mcp.command, args: opts.mcp.args, env: opts.mcp.env, tools: ["*"] } } });
  return [...base, "--additional-mcp-config", wacon, ...(opts.power === "wacon" ? ["--disable-builtin-mcps", "--no-custom-instructions"] : [])];
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => execFile(command, args, { timeout: 20_000, windowsHide: true, maxBuffer: 8 << 20 }, (_e, out) => resolve(out ?? "")));
}

/** ACP agents only say which models they have inside a session: open one, read, close. */
function probeAcp(agent: DetectedAgent, opts: AgentSessionOptions): Promise<ModelList> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (l: ModelList) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      session.close();
      resolve(l);
    };
    const session = new AcpSession(agent, acpLaunchArgs(agent, opts), { ...opts, model: undefined }, (e) => {
      if (e.type === "models") finish({ models: e.models, current: e.current });
      if (e.type === "session") setTimeout(() => finish({ models: [], current: null }), 1500);
    });
    const timer = setTimeout(() => finish({ models: [], current: null }), 45_000);
  });
}
