import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { AgentEvent, DetectedAgent } from "../../domain/agent.js";
import type { AgentSession, AgentSessionOptions } from "../../application/ports.js";
import { killTree, onLines, spawnAgent, stderrTail, textOf } from "./process.js";

/**
 * Agents without ACP that still stream structured events headlessly: one
 * process per turn, resumed by session id so the agent keeps its memory of
 * the chat between questions. The prompt goes on stdin (see process.ts).
 */
abstract class PerTurnSession implements AgentSession {
  protected sessionId: string | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private cancelled = false;

  constructor(
    protected readonly agent: DetectedAgent,
    protected readonly opts: AgentSessionOptions,
    protected readonly onEvent: (e: AgentEvent) => void
  ) {
    // Resuming across app restarts: the agent keeps its own memory of the chat.
    this.sessionId = opts.resumeSessionId ?? null;
  }

  protected abstract args(): string[];
  /** Map one JSON line of the agent's output; returns an error message when the turn failed. */
  protected abstract handle(ev: Record<string, unknown>): string | void;

  prompt(text: string): Promise<void> {
    this.cancelled = false;
    return new Promise((resolve, reject) => {
      const child = spawnAgent(this.agent.command, this.args(), this.opts.cwd);
      this.child = child;
      const tail = stderrTail(child);
      let failure: string | null = null;
      onLines(child.stdout, (line) => {
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;
        }
        const err = this.handle(ev);
        if (err) failure = err;
      });
      child.on("error", (e) => reject(new Error(`no pude iniciar ${this.agent.name}: ${e.message}`)));
      child.on("close", (code) => {
        this.child = null;
        if (this.cancelled) return reject(new Error("cancelado"));
        if (failure) return reject(new Error(failure));
        if (code !== 0) return reject(new Error(`terminó con código ${code}${tail() ? `: ${tail().slice(-400)}` : ""}`));
        this.onEvent({ type: "done" });
        resolve();
      });
      child.stdin.end(text);
    });
  }

  answerPermission(): void {
    // Tools are pre-approved on the command line (Wacon's read-only toolset only).
  }

  cancel(): void {
    this.cancelled = true;
    if (this.child) killTree(this.child);
  }

  close(): void {
    this.cancel();
  }
}

/** The MCP config both CLIs accept, pointing at `wacon mcp --toolset tui`. */
const mcpJson = (o: AgentSessionOptions) => JSON.stringify({ mcpServers: { wacon: { command: o.mcp.command, args: o.mcp.args, env: o.mcp.env } } });

/**
 * Claude Code: `claude -p --output-format stream-json`. Only Wacon's MCP
 * server is loaded (--strict-mcp-config), only its tools are allowed, and the
 * built-in tools are switched off — the agent can read the chat, nothing else.
 */
export class ClaudeSession extends PerTurnSession {
  protected args(): string[] {
    const lean = this.opts.power === "wacon";
    return [
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--mcp-config", mcpJson(this.opts),
      // Wacon's tools are pre-approved; everything else follows the user's
      // own Claude Code permission rules.
      "--allowedTools", "mcp__wacon",
      ...(lean
        ? [
            // "Solo Wacon": no other MCP servers, no built-in tools, none of the
            // coding settings/CLAUDE.md — a question drops from ~27k to ~1.5k
            // input tokens. Wacon's instructions travel in the prompt itself.
            "--strict-mcp-config",
            "--tools", "",
            "--setting-sources", "",
            "--system-prompt", "Eres el asistente de IA integrado en Wacon, un cliente de WhatsApp en la terminal. Tienes acceso a todos los chats del usuario con las herramientas wacon; sigue las instrucciones del mensaje del usuario y usa solo esas herramientas.",
          ]
        : [
            // Full: the user's own MCP servers, skills and tools come along.
            "--append-system-prompt", "Ahora trabajas dentro de Wacon, el cliente de WhatsApp del usuario en la terminal. Tienes sus chats con las herramientas wacon y, además, todas tus herramientas y MCP habituales para cumplir lo que pida.",
          ]),
      ...(this.opts.model ? ["--model", this.opts.model] : []),
      ...(this.sessionId ? ["--resume", this.sessionId] : []),
    ];
  }

  protected handle(ev: Record<string, unknown>): string | void {
    if (ev.type === "system" && ev.subtype === "init" && typeof ev.session_id === "string") {
      this.sessionId = ev.session_id;
      this.onEvent({ type: "session", sessionId: ev.session_id });
      return;
    }
    const content = ((ev.message as { content?: unknown } | undefined)?.content ?? []) as Record<string, unknown>[];
    if (ev.type === "assistant" && Array.isArray(content)) {
      for (const b of content) {
        if (b.type === "text" && typeof b.text === "string") this.onEvent({ type: "text", text: b.text });
        if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking) this.onEvent({ type: "thought", text: b.thinking });
        if (b.type === "tool_use") this.onEvent({ type: "tool", id: String(b.id), title: String(b.name ?? ""), input: b.input, status: "running" });
      }
      return;
    }
    if (ev.type === "user" && Array.isArray(content)) {
      for (const b of content) {
        if (b.type === "tool_result") this.onEvent({ type: "tool", id: String(b.tool_use_id), title: "", status: b.is_error ? "failed" : "done", output: textOf(b.content) });
      }
      return;
    }
    if (ev.type === "result") {
      const usage = (ev.usage ?? {}) as Record<string, number>;
      this.onEvent({
        type: "usage",
        inputTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
        outputTokens: usage.output_tokens,
        costUsd: typeof ev.total_cost_usd === "number" ? ev.total_cost_usd : undefined,
      });
      if (ev.is_error) return typeof ev.result === "string" && ev.result ? ev.result : String(ev.subtype ?? "error");
    }
  }
}

/** TOML basic strings are JSON-compatible for what we pass (paths, flags). */
const toml = (v: unknown) => JSON.stringify(v);

/**
 * Codex: `codex exec --json`, read-only sandbox, Wacon's MCP server injected
 * with `-c mcp_servers.wacon.*`. Follow-ups use `codex exec resume <thread>`.
 */
export class CodexSession extends PerTurnSession {
  private pendingMessage: string | null = null;

  protected args(): string[] {
    const o = this.opts;
    const config = [
      "-c", `mcp_servers.wacon.command=${toml(o.mcp.command.replace(/\\/g, "/"))}`,
      "-c", `mcp_servers.wacon.args=[${o.mcp.args.map((a) => toml(a.replace(/\\/g, "/"))).join(",")}]`,
      ...Object.entries(o.mcp.env).flatMap(([k, v]) => ["-c", `mcp_servers.wacon.env.${k}=${toml(v)}`]),
      // Exec mode never asks, so MCP calls needing approval were refused. Only
      // Wacon's tui toolset (nothing there can send) is pre-approved; the
      // read-only sandbox still bounds everything else.
      "-c", `mcp_servers.wacon.default_tools_approval_mode="approve"`,
      "-c", `approval_policy="never"`,
      // Ask for reasoning summaries: the native thinking shown in the panel.
      "-c", `model_reasoning_summary="concise"`,
    ];
    // --ignore-user-config: the user's other MCP servers and coding profile
    // don't belong in a chat question (login lives in auth.json, not config).
    // "Solo Wacon" leaves the user's config (other MCP servers, profiles) out.
    const common = ["--json", "--skip-git-repo-check", ...(o.power === "wacon" ? ["--ignore-user-config"] : []), "-s", "read-only", ...(o.model ? ["-m", o.model] : []), ...config];
    return this.sessionId ? ["exec", "resume", this.sessionId, ...common, "-"] : ["exec", ...common, "-C", o.cwd, "-"];
  }

  protected handle(ev: Record<string, unknown>): string | void {
    if (ev.type === "thread.started" && typeof ev.thread_id === "string") {
      this.sessionId = ev.thread_id;
      this.onEvent({ type: "session", sessionId: ev.thread_id });
      return;
    }
    const item = ev.item as Record<string, unknown> | undefined;
    if (item && typeof ev.type === "string" && ev.type.startsWith("item.")) {
      const done = ev.type === "item.completed";
      // Codex narrates as it goes ("Voy a revisar…") in separate messages;
      // only the last one is the answer, the earlier ones are its thinking.
      if (item.type === "agent_message" && done && typeof item.text === "string") {
        if (this.pendingMessage) this.onEvent({ type: "thought", text: `${this.pendingMessage}
` });
        this.pendingMessage = item.text;
      }
      else if (item.type === "reasoning" && done && typeof item.text === "string") this.onEvent({ type: "thought", text: item.text });
      else if (item.type === "mcp_tool_call") {
        const failed = item.status === "failed" || !!item.error;
        this.onEvent({
          type: "tool",
          id: String(item.id ?? ""),
          title: `${String(item.server ?? "")}.${String(item.tool ?? "")}`,
          input: typeof item.arguments === "string" ? safeJson(item.arguments) : item.arguments,
          status: done ? (failed ? "failed" : "done") : "running",
          output: textOf(item.result ?? item.error),
        });
      }
      return;
    }
    if (ev.type === "turn.completed") {
      if (this.pendingMessage) this.onEvent({ type: "text", text: this.pendingMessage });
      this.pendingMessage = null;
      const u = (ev.usage ?? {}) as Record<string, number>;
      this.onEvent({ type: "usage", inputTokens: u.input_tokens, outputTokens: u.output_tokens });
      return;
    }
    if (ev.type === "turn.failed") return textOf((ev.error as { message?: string } | undefined)?.message) ?? "el turno falló";
    if (ev.type === "error" && typeof ev.message === "string") return ev.message;
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
