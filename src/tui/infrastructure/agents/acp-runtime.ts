import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { AgentEvent, DetectedAgent, ModelOption, PermissionChoice } from "../../domain/agent.js";
import type { AgentSession, AgentSessionOptions } from "../../application/ports.js";
import { killTree, onLines, spawnAgent, stderrTail, textOf } from "./process.js";

/**
 * Agent Client Protocol (agentclientprotocol.com): JSON-RPC 2.0, one message
 * per line over the agent's stdio. Spoken natively by Gemini CLI, Qwen Code,
 * OpenCode, Kimi and Copilot CLI — the same channel editors like Zed use to
 * drive "the agent the user already has".
 *
 * We are the client: we create a session with Wacon's MCP server attached,
 * send prompts, and render the `session/update` stream (text chunks, tool
 * calls). We advertise no file-system or terminal capability, so the agent
 * cannot touch files through us.
 */

const PROTOCOL_VERSION = 1;
const INIT_TIMEOUT_MS = 90_000;

type Json = Record<string, unknown>;
interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

export class AcpSession implements AgentSession {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private permissionReplies = new Map<string, number | string>();
  /** Title/input per tool call: later updates (and permission-first agents) omit them. */
  private toolInfo = new Map<string, { title: string; input: unknown }>();
  private modelConfigId: string | null = null;
  private sessionId: Promise<string>;
  private closed = false;
  private tail: () => string;

  constructor(
    agent: DetectedAgent,
    args: string[],
    opts: AgentSessionOptions,
    private readonly onEvent: (e: AgentEvent) => void
  ) {
    this.child = spawnAgent(agent.command, args, opts.cwd);
    this.tail = stderrTail(this.child);
    onLines(this.child.stdout, (line) => this.receive(line));
    this.child.on("error", (e) => this.failAll(new Error(`no pude iniciar ${agent.name}: ${e.message}`)));
    this.child.on("exit", (code) => {
      if (!this.closed) this.failAll(new Error(`${agent.name} terminó (código ${code ?? "?"})${this.tail() ? `: ${this.tail().slice(-400)}` : ""}`));
    });
    this.sessionId = this.handshake(opts);
    this.sessionId.catch(() => undefined); // surfaced by prompt()
  }

  private async handshake(opts: AgentSessionOptions): Promise<string> {
    await this.request(
      "initialize",
      { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "wacon", version: "1" } },
      INIT_TIMEOUT_MS
    );
    const res = (await this.request(
      "session/new",
      {
        cwd: opts.cwd,
        mcpServers: [{ name: "wacon", command: opts.mcp.command, args: opts.mcp.args, env: Object.entries(opts.mcp.env).map(([name, value]) => ({ name, value })) }],
      },
      INIT_TIMEOUT_MS
    )) as { sessionId?: string };
    if (!res?.sessionId) throw new Error("el agente no abrió una sesión");
    this.onEvent({ type: "session", sessionId: res.sessionId });
    const offered = modelsFrom(res as Json);
    if (offered) {
      this.modelConfigId = offered.configId;
      this.onEvent({ type: "models", models: offered.models, current: offered.current });
      // Apply the user's choice. Newer agents expose it as a config option,
      // older ones through session/set_model; a refusal keeps the default.
      if (opts.model && opts.model !== offered.current && offered.models.some((m) => m.id === opts.model)) {
        const call = offered.configId
          ? this.request("session/set_config_option", { sessionId: res.sessionId, configId: offered.configId, value: opts.model }, INIT_TIMEOUT_MS)
          : this.request("session/set_model", { sessionId: res.sessionId, modelId: opts.model }, INIT_TIMEOUT_MS);
        await call.then(() => this.onEvent({ type: "models", models: offered.models, current: opts.model! })).catch(() => undefined);
      }
    }
    return res.sessionId;
  }

  async prompt(text: string): Promise<void> {
    const sessionId = await this.sessionId;
    const res = (await this.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] })) as {
      stopReason?: string;
      usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null;
    };
    if (res?.usage) this.onEvent({ type: "usage", inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens });
    this.onEvent({ type: "done", stopReason: res?.stopReason });
  }

  answerPermission(requestId: string, optionId: string | null): void {
    const rpcId = this.permissionReplies.get(requestId);
    if (rpcId === undefined) return;
    this.permissionReplies.delete(requestId);
    this.write({ jsonrpc: "2.0", id: rpcId, result: { outcome: optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" } } });
  }

  cancel(): void {
    for (const id of [...this.permissionReplies.keys()]) this.answerPermission(id, null);
    void this.sessionId.then((sessionId) => this.write({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } })).catch(() => undefined);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error("sesión cerrada"));
    killTree(this.child);
  }

  // ── JSON-RPC ─────────────────────────────────────────────
  private write(msg: Json): void {
    if (this.closed && !("result" in msg)) return;
    try {
      this.child.stdin.write(`${JSON.stringify(msg)}\n`);
    } catch {
      // the exit handler reports the failure
    }
  }

  private request(method: string, params: Json, timeoutMs = 0): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs ? setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`el agente no respondió a ${method} en ${Math.round(timeoutMs / 1000)} s${this.tail() ? `: ${this.tail().slice(-300)}` : ""}`));
      }, timeoutMs) : null;
      this.pending.set(id, {
        resolve: (v) => {
          if (timer) clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          if (timer) clearTimeout(timer);
          reject(e);
        },
      });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private failAll(e: Error): void {
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }

  private receive(line: string): void {
    let msg: Json;
    try {
      msg = JSON.parse(line) as Json;
    } catch {
      return; // agents sometimes log plain text to stdout
    }
    const id = msg.id as number | string | undefined;
    const method = msg.method as string | undefined;
    if (method && id !== undefined) return this.onRequest(id, method, (msg.params ?? {}) as Json);
    if (method) return this.onNotification(method, (msg.params ?? {}) as Json);
    if (id !== undefined) {
      const p = this.pending.get(id as number);
      if (!p) return;
      this.pending.delete(id as number);
      const err = msg.error as { message?: string; data?: unknown } | undefined;
      if (err) p.reject(new Error([err.message, textOf(err.data)].filter(Boolean).join(": ") || "error del agente"));
      else p.resolve(msg.result);
    }
  }

  private onRequest(id: number | string, method: string, params: Json): void {
    if (method === "session/request_permission") {
      const requestId = `p${String(id)}`;
      this.permissionReplies.set(requestId, id);
      const tool = (params.toolCall ?? {}) as Json;
      // Gemini asks permission BEFORE announcing the call: show the step now.
      const callId = String(tool.toolCallId ?? "");
      if (callId && typeof tool.title === "string") {
        this.toolInfo.set(callId, { title: tool.title, input: tool.rawInput });
        this.onEvent({ type: "tool", id: callId, title: tool.title, input: tool.rawInput, status: "running" });
      }
      const options = ((params.options ?? []) as Json[]).map<PermissionChoice>((o) => ({
        id: String(o.optionId),
        label: String(o.name ?? o.optionId),
        kind: (o.kind as PermissionChoice["kind"]) ?? "allow_once",
      }));
      this.onEvent({ type: "permission", requestId, title: String(tool.title ?? "una acción"), options });
      return;
    }
    // We offered no fs/terminal capability; refuse anything else politely.
    this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Wacon no ofrece ${method}` } });
  }

  private onNotification(method: string, params: Json): void {
    if (method !== "session/update") return;
    const u = (params.update ?? {}) as Json;
    switch (u.sessionUpdate) {
      case "agent_message_chunk": {
        const c = u.content as Json | undefined;
        if (c?.type === "text" && typeof c.text === "string") this.onEvent({ type: "text", text: c.text });
        return;
      }
      case "agent_thought_chunk": {
        const c = u.content as Json | undefined;
        if (c?.type === "text" && typeof c.text === "string") this.onEvent({ type: "thought", text: c.text });
        return;
      }
      case "tool_call":
      case "tool_call_update": {
        const status = u.status === "completed" ? "done" : u.status === "failed" ? "failed" : "running";
        const output = textOf(u.rawOutput) ?? (Array.isArray(u.content) ? textOf((u.content as Json[]).map((c) => c.content ?? c)) : undefined);
        const id = String(u.toolCallId ?? "");
        const known = this.toolInfo.get(id);
        const title = typeof u.title === "string" && u.title ? u.title : (known?.title ?? "");
        const input = u.rawInput ?? known?.input;
        if (title) this.toolInfo.set(id, { title, input });
        this.onEvent({ type: "tool", id, title, input, status, output });
        return;
      }
      case "config_option_update": {
        const offered = modelsFrom(u);
        if (offered) this.onEvent({ type: "models", models: offered.models, current: offered.current });
        return;
      }
      default:
        return;
    }
  }
}

/**
 * Models from an ACP payload: the `configOptions` entry with category
 * "model" (current spec) or the older `models` state. Grouped selects are
 * flattened.
 */
export function modelsFrom(p: Json): { models: ModelOption[]; current: string | null; configId: string | null } | null {
  const opts = Array.isArray(p.configOptions) ? (p.configOptions as Json[]) : [];
  const sel = opts.find((o) => o.category === "model" && o.type !== "boolean");
  if (sel && Array.isArray(sel.options)) {
    const flat = (sel.options as Json[]).flatMap((o) => (Array.isArray(o.options) ? (o.options as Json[]) : [o]));
    const models = flat.filter((o) => o.value !== undefined).map((o) => ({ id: String(o.value), name: String(o.name ?? o.value), ...(o.description ? { description: String(o.description) } : {}) }));
    if (models.length) return { models, current: sel.currentValue !== undefined ? String(sel.currentValue) : null, configId: String(sel.id) };
  }
  const st = p.models as Json | undefined;
  if (st && Array.isArray(st.availableModels)) {
    const models = (st.availableModels as Json[]).map((m) => ({ id: String(m.modelId), name: String(m.name ?? m.modelId), ...(m.description ? { description: String(m.description) } : {}) }));
    if (models.length) return { models, current: st.currentModelId ? String(st.currentModelId) : null, configId: null };
  }
  return null;
}
