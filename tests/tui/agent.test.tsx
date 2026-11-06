import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import {
  buildContextCapsule,
  composePrompt,
  deltaSince,
  draftFrom,
  autoApproval,
  matchQuickActions,
  readIdsFrom,
  toolLabel,
  waconTool,
  type AgentEvent,
  type DetectedAgent,
} from "../../src/tui/domain/agent.js";
import type { ChatMessage } from "../../src/tui/domain/message.js";
import { AcpSession } from "../../src/tui/infrastructure/agents/acp-runtime.js";
import { ClaudeSession, CodexSession } from "../../src/tui/infrastructure/agents/stream-runtimes.js";
import { findOnPath, parseVersion } from "../../src/tui/infrastructure/agents/catalog.js";
import { AgentController, friendlyError } from "../../src/tui/application/agent-controller.js";
import { UltraController } from "../../src/tui/application/controller.js";
import type { AgentRuntimePort, AgentSession, ChatGateway, IncomingEvent } from "../../src/tui/application/ports.js";
import { DEFAULT_PREFERENCES } from "../../src/tui/domain/preferences.js";
import { App } from "../../src/tui/presentation/App.js";
import { plainText } from "../../src/tui/presentation/components/AgentPanel.js";

const msg = (id: string, ts: number, text: string, fromMe = false): ChatMessage => ({
  id, chatJid: "a@lid", senderJid: fromMe ? null : "a@lid", fromMe, ts, text, kind: "text", status: fromMe ? "sent" : "received",
});

describe("agent domain", () => {
  it("finds the Wacon tool whatever the agent calls it", () => {
    expect(waconTool("mcp__wacon__read_messages")).toBe("read_messages");
    expect(waconTool("wacon.search_messages")).toBe("search_messages");
    expect(waconTool("read_messages (wacon MCP Server)")).toBe("read_messages");
    expect(waconTool("propose_reply")).toBe("propose_reply");
    expect(waconTool("Bash")).toBeNull();
    // "read_episode" must not be mistaken for a prefix of something else.
    expect(waconTool("wacon__read_episode")).toBe("read_episode");
  });

  it("labels tool calls in plain words", () => {
    expect(toolLabel("mcp__wacon__read_messages", { limit: 40 })).toBe("📖 Leyendo 40 mensajes");
    expect(toolLabel("search_messages", { query: "viaje" })).toBe("🔎 Buscando «viaje» en todos tus chats");
    expect(toolLabel("remember_fact", { fact: "le gusta el café" })).toContain("💾 Guardando: le gusta el café");
    expect(toolLabel("weird_tool", {})).toBe("🔧 weird_tool");
  });

  it("turns propose_reply into a draft, and nothing else", () => {
    expect(draftFrom("mcp__wacon__propose_reply", { chat: "a@lid", text: " hola " , reply_to: "m1" })).toEqual({ chatJid: "a@lid", text: "hola", replyTo: "m1" });
    expect(draftFrom("send_message", { text: "x" })).toBeNull();
    expect(draftFrom("propose_reply", { text: "   " })).toBeNull();
  });

  it("knows which loaded messages a tool showed the agent", () => {
    const loaded = [msg("m1", 1, "a"), msg("m2", 2, "b"), msg("m3", 3, "c")];
    expect(readIdsFrom("read_messages", { limit: 2 }, '[{"id":"m3"},{"id":"zz"}]', loaded)).toEqual(["m3"]);
    expect(readIdsFrom("read_messages", { limit: 2 }, undefined, loaded)).toEqual(["m2", "m3"]);
    expect(readIdsFrom("view_image", { message_id: "m1" }, "{}", loaded)).toEqual(["m1"]);
    expect(readIdsFrom("Bash", {}, '"id":"m1"', loaded)).toEqual([]);
  });

  it("builds a capsule within budget, keeping the newest messages", () => {
    const messages = Array.from({ length: 200 }, (_, i) => msg(`m${i}`, 1_700_000_000_000 + i * 60_000, `mensaje número ${i} ${"x".repeat(80)}`, i % 3 === 0));
    const input = { chatJid: "a@lid", chatName: "Ana López", isGroup: false, isSelf: false, unread: 2, messages, memberNames: {}, selected: null };
    const { text, includedIds } = buildContextCapsule(input, 3000);
    expect(text.length).toBeLessThanOrEqual(3000);
    expect(includedIds[0]).toBe("m199");
    expect(text).toContain("mensaje número 199");
    expect(text).not.toContain("mensaje número 10 ");
    expect(text).toContain("hay ");
    expect(text).toContain("sin leer: 2");
    // Follow-ups only carry what is new.
    expect(deltaSince(input, messages[198]!.ts)).toContain("mensaje número 199");
    expect(deltaSince(input, messages[199]!.ts)).toBeNull();
  });

  it("composes the prompt and filters quick actions", () => {
    expect(composePrompt({ request: "resume", brief: "B", context: "C" })).toBe("B\n\n<contexto_del_chat>\nC\n</contexto_del_chat>\n\nPetición del usuario: resume");
    expect(composePrompt({ request: "y?", brief: null, context: null })).toBe("Petición del usuario: y?");
    expect(matchQuickActions("/").length).toBeGreaterThan(5);
    expect(matchQuickActions("/resp").map((a) => a.id)).toEqual(["responder"]);
  });

  it("renders agent Markdown as plain panel text", () => {
    expect(plainText("## Resumen\n- **Ana** confirmó `8pm`\n* otra")).toEqual(["Resumen", "• Ana confirmó 8pm", "• otra"]);
  });

  it("approves Wacon's own tools for the session, and leaves anything else to the user", () => {
    const gemini = [
      { id: "proceed_always_server", label: "Siempre (servidor)", kind: "allow_always" as const },
      { id: "proceed_always_tool", label: "Siempre (herramienta)", kind: "allow_always" as const },
      { id: "proceed_once", label: "Una vez", kind: "allow_once" as const },
      { id: "cancel", label: "No", kind: "reject_once" as const },
    ];
    expect(autoApproval("read_messages (wacon MCP Server)", gemini)).toBe("proceed_always_server");
    expect(autoApproval("propose_reply", [{ id: "y", label: "Sí", kind: "allow_once" }])).toBe("y");
    expect(autoApproval("Shell: rm -rf build", gemini)).toBeNull();
    expect(autoApproval("WriteFile notes.md", gemini)).toBeNull();
  });

  it("explains the usual agent failures", () => {
    const a: DetectedAgent = { id: "gemini", name: "Gemini CLI", protocol: "acp", command: "g", version: null };
    expect(friendlyError("Authentication required", a)).toContain("iniciar sesión");
    expect(friendlyError("429 Too Many Requests", a)).toContain("límite");
  });
});

describe("ACP runtime against a real ACP process", () => {
  it("handshakes with Wacon's MCP attached, streams a turn, asks permission, and proposes a draft", async () => {
    const events: AgentEvent[] = [];
    const agent: DetectedAgent = { id: "fake", name: "Fake", protocol: "acp", command: process.execPath, version: "1" };
    let session!: AcpSession;
    const permissionAsked = new Promise<void>((resolve) => {
      session = new AcpSession(agent, [join(__dirname, "../fixtures/fake-acp-agent.mjs")], { cwd: tmpdir(), mcp: { command: "node", args: ["wacon", "mcp", "--toolset", "tui"], env: { WACON_CLIENT_NAME: "ia-fake" } } }, (e) => {
        events.push(e);
        if (e.type === "permission") {
          resolve();
          session.answerPermission(e.requestId, e.options[0]!.id);
        }
      });
    });
    await session.prompt("resume el chat");
    await permissionAsked;
    session.close();

    expect(events.find((e) => e.type === "session")).toEqual({ type: "session", sessionId: "S1" });
    const text = events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("");
    expect(text).toBe("Hola, **listo**.");
    const tools = events.filter((e) => e.type === "tool") as Extract<AgentEvent, { type: "tool" }>[];
    expect(tools[0]).toMatchObject({ id: "t1", title: "read_messages (wacon MCP Server)", status: "running", input: { chat: "a@lid", limit: 2 } });
    expect(tools[1]).toMatchObject({ id: "t1", status: "done" });
    expect(tools[1]!.output).toContain('"id":"m2"');
    expect(tools.find((t) => t.id === "t3")?.input).toEqual({ chat: "a@lid", text: "¡Claro, nos vemos a las 8!" });
    expect(events).toContainEqual({ type: "usage", inputTokens: 120, outputTokens: 30 });
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "end_turn" });

    // What the agent received: no fs/terminal capability, Wacon MCP attached, answer to the permission.
    const log = JSON.parse((events.find((e) => e.type === "thought") as { text: string }).text) as { method: string; params: Record<string, unknown> }[];
    const init = log.find((l) => l.method === "initialize")!.params as { clientCapabilities: { fs: { readTextFile: boolean }; terminal: boolean } };
    expect(init.clientCapabilities).toEqual({ fs: { readTextFile: false, writeTextFile: false }, terminal: false });
    const created = log.find((l) => l.method === "session/new")!.params as { mcpServers: unknown[] };
    expect(created.mcpServers).toEqual([{ name: "wacon", command: "node", args: ["wacon", "mcp", "--toolset", "tui"], env: [{ name: "WACON_CLIENT_NAME", value: "ia-fake" }] }]);
    expect(log.find((l) => l.method === "permission-answer")!.params).toEqual({ outcome: { outcome: "selected", optionId: "ok" } });
  }, 20_000);

  it("surfaces the agent's error instead of hanging", async () => {
    const agent: DetectedAgent = { id: "fake", name: "Fake", protocol: "acp", command: process.execPath, version: "1" };
    const s = new AcpSession(agent, [join(__dirname, "../fixtures/fake-acp-agent.mjs")], { cwd: tmpdir(), mcp: { command: "x", args: [], env: {} } }, () => undefined);
    await expect(s.prompt("FAIL please")).rejects.toThrow(/Authentication required/);
    s.close();
  }, 20_000);
});

/** Exposes the per-line parsers of the stream runtimes. */
class TestClaude extends ClaudeSession {
  feed(ev: Record<string, unknown>) {
    return this.handle(ev);
  }
  argv() {
    return this.args();
  }
}
class TestCodex extends CodexSession {
  feed(ev: Record<string, unknown>) {
    return this.handle(ev);
  }
  argv() {
    return this.args();
  }
}

describe("stream runtimes (Claude Code, Codex)", () => {
  const opts = { cwd: "C:/home/.wacon", mcp: { command: "C:\\node\\node.exe", args: ["C:\\w\\dist\\index.js", "mcp", "--toolset", "tui"], env: { WACON_CLIENT_NAME: "ia-x" } } };

  it("Claude: only Wacon's MCP, no built-in tools, resumes its session, maps events", () => {
    const events: AgentEvent[] = [];
    // Default = full powers: the user's own MCP servers/settings come along, Wacon added on top.
    const full = new TestClaude({ id: "claude", name: "Claude Code", protocol: "claude-stream", command: "claude.exe", version: "2" }, opts, () => undefined).argv();
    expect(full).not.toContain("--strict-mcp-config");
    expect(full).not.toContain("--tools");
    expect(full).toContain("--append-system-prompt");
    // "Solo Wacon": the lean, cheap configuration.
    const c = new TestClaude({ id: "claude", name: "Claude Code", protocol: "claude-stream", command: "claude.exe", version: "2" }, { ...opts, power: "wacon" }, (e) => events.push(e));
    const first = c.argv();
    expect(first).toEqual(expect.arrayContaining(["-p", "--strict-mcp-config", "--allowedTools", "mcp__wacon", "--tools", ""]));
    expect(JSON.parse(first[first.indexOf("--mcp-config") + 1]!)).toEqual({ mcpServers: { wacon: opts.mcp } });
    c.feed({ type: "system", subtype: "init", session_id: "abc" });
    expect(c.argv().slice(-2)).toEqual(["--resume", "abc"]);
    c.feed({ type: "assistant", message: { content: [{ type: "text", text: "Hola" }, { type: "tool_use", id: "u1", name: "mcp__wacon__read_messages", input: { limit: 5 } }] } });
    c.feed({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "u1", content: [{ type: "text", text: '{"id":"m1"}' }] }] } });
    expect(c.feed({ type: "result", is_error: false, usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 }, total_cost_usd: 0.002 })).toBeUndefined();
    expect(events).toEqual([
      { type: "session", sessionId: "abc" },
      { type: "text", text: "Hola" },
      { type: "tool", id: "u1", title: "mcp__wacon__read_messages", input: { limit: 5 }, status: "running" },
      { type: "tool", id: "u1", title: "", status: "done", output: '{"id":"m1"}' },
      { type: "usage", inputTokens: 100, outputTokens: 5, costUsd: 0.002 },
    ]);
    expect(c.feed({ type: "result", is_error: true, result: "Invalid API key" })).toBe("Invalid API key");
  });

  it("Codex: read-only sandbox, MCP injected as TOML, resume by thread id, maps events", () => {
    const events: AgentEvent[] = [];
    const c = new TestCodex({ id: "codex", name: "Codex", protocol: "codex-json", command: "codex.exe", version: "0.1" }, opts, (e) => events.push(e));
    const first = c.argv();
    expect(first.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(first).not.toContain("-s");
    expect(first).toEqual(expect.arrayContaining(['sandbox_mode="read-only"', 'mcp_servers.wacon.default_tools_approval_mode="approve"', "mcp_servers.wacon.command=\"C:/node/node.exe\"", 'mcp_servers.wacon.args=["C:/w/dist/index.js","mcp","--toolset","tui"]', "-"]));
    c.feed({ type: "thread.started", thread_id: "th1" });
    expect(c.argv().slice(0, 3)).toEqual(["exec", "resume", "th1"]);
    // Follow-up turns resume: only options `codex exec resume` accepts.
    const resume = c.argv();
    expect(resume).not.toContain("-s");
    expect(resume).not.toContain("-C");
    expect(resume).toContain('sandbox_mode="read-only"');
    c.feed({ type: "item.started", item: { id: "i1", type: "mcp_tool_call", server: "wacon", tool: "search_messages", arguments: '{"query":"viaje"}', status: "in_progress" } });
    c.feed({ type: "item.completed", item: { id: "i1", type: "mcp_tool_call", server: "wacon", tool: "search_messages", arguments: { query: "viaje" }, result: { content: [{ type: "text", text: "[]" }] }, status: "completed" } });
    c.feed({ type: "item.completed", item: { id: "i2", type: "agent_message", text: "Nada sobre el viaje." } });
    c.feed({ type: "turn.completed", usage: { input_tokens: 50, output_tokens: 7 } });
    expect(events).toEqual([
      { type: "session", sessionId: "th1" },
      { type: "tool", id: "i1", title: "wacon.search_messages", input: { query: "viaje" }, status: "running", output: undefined },
      { type: "tool", id: "i1", title: "wacon.search_messages", input: { query: "viaje" }, status: "done", output: "[]" },
      { type: "text", text: "Nada sobre el viaje." },
      { type: "usage", inputTokens: 50, outputTokens: 7 },
    ]);
    expect(c.feed({ type: "turn.failed", error: { message: "quota exceeded" } })).toBe("quota exceeded");
  });
});

describe("agent detection", () => {
  it("prefers a native .exe over an npm shim and skips extension-less shell scripts on Windows", () => {
    const a = mkdtempSync(join(tmpdir(), "wacon-path-a-"));
    const b = mkdtempSync(join(tmpdir(), "wacon-path-b-"));
    writeFileSync(join(a, "gemini"), "#!/bin/sh"); // POSIX shim — not spawnable on Windows
    writeFileSync(join(a, "gemini.cmd"), "@echo off");
    writeFileSync(join(a, "codex.cmd"), "@echo off");
    writeFileSync(join(a, "codex.exe"), "MZ");
    writeFileSync(join(b, "claude.exe"), "MZ");
    const env = { PATH: `${a};${b}`, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
    expect(findOnPath("gemini", env, "win32")).toBe(join(a, "gemini.cmd"));
    expect(findOnPath("codex", env, "win32")).toBe(join(a, "codex.exe"));
    expect(findOnPath("claude", env, "win32")).toBe(join(b, "claude.exe"));
    expect(findOnPath("kimi", env, "win32")).toBeNull();
  });

  it("reads versions from the usual --version banners", () => {
    expect(parseVersion("2.1.316 (Claude Code)")).toBe("2.1.316");
    expect(parseVersion("codex-cli 0.165.0")).toBe("0.165.0");
    expect(parseVersion("GitHub Copilot CLI 1.0.105.")).toBe("1.0.105");
    expect(parseVersion("nothing")).toBeNull();
  });
});

// ── controller + app, with a scripted agent ─────────────────

class ScriptedRuntime implements AgentRuntimePort {
  prompts: string[] = [];
  opened = 0;
  script: (emit: (e: AgentEvent) => void, prompt: string) => Promise<void> = async (emit) => {
    emit({ type: "tool", id: "t1", title: "mcp__wacon__read_messages", input: { limit: 2 }, status: "running" });
    emit({ type: "tool", id: "t1", title: "", status: "done", output: '[{"id":"m1"}]' });
    emit({ type: "text", text: "Ana pregunta si vas a la cena." });
    emit({ type: "tool", id: "t2", title: "mcp__wacon__propose_reply", input: { chat: "a@lid", text: "¡Sí, llego a las 8!" }, status: "done" });
    emit({ type: "usage", inputTokens: 900, outputTokens: 60, costUsd: 0.004 });
  };
  open(_a: DetectedAgent, _o: unknown, onEvent: (e: AgentEvent) => void): AgentSession {
    this.opened++;
    return {
      prompt: async (text) => {
        this.prompts.push(text);
        await this.script(onEvent, text);
      },
      answerPermission: () => undefined,
      cancel: () => undefined,
      close: () => undefined,
    };
  }
}

const now = Date.now();
function fakeGateway(sent: { text: string; replyTo?: string }[]): ChatGateway {
  return {
    linkState: async () => ({ state: "connected", selfName: null }),
    relink: async () => "connected",
    qr: async () => ({ state: "connected", qr: null }),
    overview: async () => [{ jid: "a@lid", is_group: 0, unread_count: 1, last_message_ts: now, display_name: "Ana", alt_jid: null, last_text: "¿vienes?", last_from_me: 0, last_type: "text", last_sender_name: null }],
    messages: async () => [
      { id: "m2", chat_jid: "a@lid", sender_jid: "a@lid", from_me: 0, timestamp: now - 1000, text: "¿vienes a la cena?", message_type: "text" },
      { id: "m1", chat_jid: "a@lid", sender_jid: null, from_me: 1, timestamp: now - 5000, text: "hola Ana", message_type: "text" },
    ],
    memberNames: async () => ({}),
    presence: async () => ({ status: "unknown", lastSeenRelative: null }),
    sendText: async (_j: string, text: string, replyTo?: string) => (sent.push({ text, replyTo }), { ok: true, messageId: "srv" }),
    messagesByIds: async () => [], reactions: async () => [], react: async () => ({ ok: true, messageId: "r" }), messageStatuses: async () => [],
    markRead: async () => undefined, waitForMessages: () => new Promise<{ cursor: number; events: IncomingEvent[] }>(() => undefined), currentCursor: async () => 0,
    sendFile: async () => ({ ok: true, messageId: "f" }), fileExists: () => true, fetchMedia: async () => null, openMedia: async () => "ok",
    search: async () => [], stickerMoods: async () => [], stickers: async () => [], sendSticker: async () => ({ ok: true, messageId: "s" }), sendVoice: async () => ({ ok: true, messageId: "v" }),
  } as unknown as ChatGateway;
}
const AGENTS: DetectedAgent[] = [
  { id: "claude", name: "Claude Code", protocol: "claude-stream", command: "claude.exe", version: "2.1.316" },
  { id: "gemini", name: "Gemini CLI", protocol: "acp", command: "gemini.cmd", version: "0.47.0" },
];
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

async function setup(prefs = DEFAULT_PREFERENCES) {
  const sent: { text: string; replyTo?: string }[] = [];
  let saved = prefs;
  const ultra = new UltraController(fakeGateway(sent), Date.now, { load: () => saved, save: (p) => void (saved = p), location: () => "x" });
  const runtime = new ScriptedRuntime();
  const agent = new AgentController(ultra, { detect: async () => AGENTS }, runtime, () => ({ cwd: "/tmp", mcp: { command: "node", args: [], env: {} } }));
  await ultra.start();
  await ultra.openChat("a@lid");
  return { ultra, agent, runtime, sent };
}

describe("AgentController", () => {
  it("first question carries brief + capsule; follow-ups only the delta; events become steps, marks and a draft", async () => {
    const { agent, runtime, ultra } = await setup({ ...DEFAULT_PREFERENCES, agent: "claude" });
    await agent.detect();
    expect(agent.active()?.name).toBe("Claude Code");
    await agent.ask("¿qué quiere Ana?");
    const first = runtime.prompts[0]!;
    expect(first).toContain("NUNCA envíes mensajes");
    expect(first).toContain("¿vienes a la cena?");
    expect(first).toContain("Petición del usuario: ¿qué quiere Ana?");

    const chat = agent.chat("a@lid");
    expect(chat.turns[0]).toMatchObject({ status: "done", text: "Ana pregunta si vas a la cena." });
    expect(chat.turns[0]!.tools.map((t) => [t.label, t.status])).toEqual([["📖 Leyendo 2 mensajes", "done"], ["💬 Proponiendo un mensaje", "done"]]);
    expect(chat.readIds).toEqual(expect.arrayContaining(["m1", "m2"]));
    expect(chat.draft).toEqual({ chatJid: "a@lid", text: "¡Sí, llego a las 8!", replyTo: null });
    expect(chat.usage).toEqual({ inputTokens: 900, outputTokens: 60, costUsd: 0.004 });

    await agent.ask("¿y algo más?");
    expect(runtime.opened).toBe(1); // same session, the agent remembers
    expect(runtime.prompts[1]).toBe("Petición del usuario: ¿y algo más?"); // nothing new arrived: no context resent
    expect(agent.chat("a@lid").draft).not.toBeNull();
    expect(ultra.getState().openJid).toBe("a@lid");
  });

  it("only the user sends a draft, and a failing agent becomes a readable error", async () => {
    const { agent, runtime, sent } = await setup({ ...DEFAULT_PREFERENCES, agent: "claude" });
    await agent.detect();
    await agent.ask("propón algo");
    expect(sent).toEqual([]); // the agent never sends
    await agent.sendDraft("a@lid");
    expect(sent).toEqual([{ text: "¡Sí, llego a las 8!", replyTo: undefined }]);

    runtime.script = async () => {
      throw new Error("401 Unauthorized");
    };
    await agent.ask("otra");
    const last = agent.chat("a@lid").turns.at(-1)!;
    expect(last.status).toBe("error");
    expect(last.error).toContain("iniciar sesión");
    expect(agent.getState().busyJid).toBeNull();
  });
});

describe("Modo IA in the app", () => {
  const ESC = "\x1b";
  const ENTER = "\r";
  const CTRL_A = "\x01";
  const TAB = "\t";

  it("Ctrl+A picks an agent, / runs a quick action, the draft goes to the composer with Tab", async () => {
    const { ultra, agent, runtime } = await setup();
    const ui = render(<App controller={ultra} files={{ complete: () => [], exists: () => true, home: () => "/" }} agent={agent} />);
    await settle();
    // The list starts with Wacon's own "Wacon IA" row; Ana's chat is next.
    ui.stdin.write("\x1b[B");
    await settle();
    ui.stdin.write(ENTER); // open Ana and focus the composer
    await settle();
    ui.stdin.write(CTRL_A);
    await settle(120);
    expect(ui.lastFrame()).toContain("elige tu agente");
    expect(ui.lastFrame()).toContain("Claude Code");
    expect(ui.lastFrame()).toContain("Gemini CLI");
    ui.stdin.write(ENTER); // choose Claude Code
    await settle(120);
    expect(ultra.getState().prefs.agent).toBe("claude");
    expect(ui.lastFrame()).toContain("está listo para Ana");

    ui.stdin.write("/");
    await settle();
    expect(ui.lastFrame()).toContain("Resumir el chat");
    ui.stdin.write("resp");
    await settle();
    ui.stdin.write(ENTER);
    await settle(150);
    expect(runtime.prompts[0]).toContain("Propón una respuesta");
    const frame = ui.lastFrame() ?? "";
    expect(frame).toContain("Sugerir respuesta");
    expect(frame).toContain("Leyendo 2 mensajes");
    expect(frame).toContain("Borrador para Ana");
    expect(frame).toContain("¡Sí, llego a las 8!");

    ui.stdin.write(TAB); // draft → composer
    await settle();
    expect(agent.chat("a@lid").draft).toBeNull();
    expect(ui.lastFrame()).toContain("¡Sí, llego a las 8!");
    ui.stdin.write(ESC);
    ultra.stop();
    agent.stop();
    ui.unmount();
  });
});

describe("Codex flags match the installed CLI", () => {
  const codex = findOnPath("codex");
  it.skipIf(!codex)("every flag Wacon passes to `codex exec` and `codex exec resume` exists there", async () => {
    const { execFileSync } = await import("node:child_process");
    const help = (args: string[]) => execFileSync(codex!, [...args, "--help"], { encoding: "utf8", timeout: 30_000 });
    const flagsIn = (text: string) => new Set([...text.matchAll(/(?:^|\s)(-{1,2}[a-zA-Z][\w-]*)/g)].map((m) => m[1]!));
    const opts = { cwd: "C:/x", mcp: { command: "node", args: ["w", "mcp"], env: { A: "1" } }, model: "m" };
    const s = new TestCodex({ id: "codex", name: "Codex", protocol: "codex-json", command: codex!, version: "1" }, opts, () => undefined);
    const used = (argv: string[]) => argv.filter((a) => /^-{1,2}[a-zA-Z]/.test(a));
    const exec = flagsIn(help(["exec"]));
    for (const f of used(s.argv())) expect(exec.has(f), `codex exec ${f}`).toBe(true);
    s.feed({ type: "thread.started", thread_id: "t" });
    const resume = flagsIn(help(["exec", "resume"]));
    for (const f of used(s.argv())) expect(resume.has(f), `codex exec resume ${f}`).toBe(true);
  }, 60_000);
});
