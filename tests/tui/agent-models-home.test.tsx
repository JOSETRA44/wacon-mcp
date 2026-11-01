import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { autoApproval, handoffRecap, homeCapsule, isQuotaError, TOOL_TITLES, TUI_TOOLSET, waconTool, type AgentEvent, type DetectedAgent } from "../../src/tui/domain/agent.js";
import { readFileSync } from "node:fs";
import { AcpSession, modelsFrom } from "../../src/tui/infrastructure/agents/acp-runtime.js";
import { ClaudeSession, CodexSession } from "../../src/tui/infrastructure/agents/stream-runtimes.js";
import { parseCodexModels } from "../../src/tui/infrastructure/agents/runtime.js";
import { AgentController } from "../../src/tui/application/agent-controller.js";
import { UltraController } from "../../src/tui/application/controller.js";
import type { AgentRuntimePort, AgentSession, AgentSessionOptions, ChatGateway, IncomingEvent } from "../../src/tui/application/ports.js";
import { DEFAULT_PREFERENCES, sanitizePreferences, type Preferences } from "../../src/tui/domain/preferences.js";
import { turnLines } from "../../src/tui/presentation/components/AgentPanel.js";
import { App } from "../../src/tui/presentation/App.js";
import { resolveTheme } from "../../src/tui/presentation/themes.js";

describe("models", () => {
  it("reads ACP models from configOptions (grouped) and from the older models state", () => {
    expect(
      modelsFrom({
        configOptions: [
          { id: "mode", category: "mode", type: "select", currentValue: "x", options: [] },
          { id: "model", category: "model", type: "select", currentValue: "pro", options: [{ group: "g", name: "G", options: [{ value: "pro", name: "Pro" }, { value: "flash", name: "Flash", description: "rápido" }] }] },
        ],
      })
    ).toEqual({ models: [{ id: "pro", name: "Pro" }, { id: "flash", name: "Flash", description: "rápido" }], current: "pro", configId: "model" });
    expect(modelsFrom({ models: { currentModelId: "a", availableModels: [{ modelId: "a", name: "A" }] } })).toEqual({ models: [{ id: "a", name: "A" }], current: "a", configId: null });
    expect(modelsFrom({})).toBeNull();
  });

  it("an ACP session reports its models and applies the chosen one", async () => {
    const events: AgentEvent[] = [];
    const agent: DetectedAgent = { id: "fake", name: "Fake", protocol: "acp", command: process.execPath, version: "1" };
    const s = new AcpSession(agent, [join(__dirname, "../fixtures/fake-acp-agent.mjs")], { cwd: tmpdir(), mcp: { command: "node", args: [], env: {} }, model: "flash" }, (e) => {
      events.push(e);
      if (e.type === "permission") s.answerPermission(e.requestId, e.options[0]!.id);
    });
    await s.prompt("hola");
    s.close();
    const models = events.filter((e) => e.type === "models") as Extract<AgentEvent, { type: "models" }>[];
    expect(models[0]).toMatchObject({ current: "pro" });
    expect(models.at(-1)).toMatchObject({ current: "flash" });
    const log = JSON.parse((events.find((e) => e.type === "thought") as { text: string }).text) as { method: string; params: unknown }[];
    expect(log.find((l) => l.method === "session/set_config_option")?.params).toEqual({ sessionId: "S1", configId: "model", value: "flash" });
  }, 20_000);

  it("Claude gets --model and its thinking blocks become thoughts; Codex's catalog is parsed", () => {
    const events: AgentEvent[] = [];
    class T extends ClaudeSession {
      argv() { return this.args(); }
      feed(e: Record<string, unknown>) { return this.handle(e); }
    }
    const c = new T({ id: "claude", name: "Claude Code", protocol: "claude-stream", command: "claude.exe", version: "2" }, { cwd: ".", mcp: { command: "n", args: [], env: {} }, model: "haiku" }, (e) => events.push(e));
    expect(c.argv()).toEqual(expect.arrayContaining(["--model", "haiku"]));
    c.feed({ type: "assistant", message: { content: [{ type: "thinking", thinking: "Busco en los grupos…" }, { type: "text", text: "Listo" }] } });
    expect(events).toEqual([{ type: "thought", text: "Busco en los grupos…" }, { type: "text", text: "Listo" }]);
    expect(parseCodexModels(JSON.stringify({ models: [{ slug: "gpt-x", display_name: "GPT-X", description: "d" }, { slug: "codex-auto-review", display_name: "R" }] }))).toEqual([{ id: "gpt-x", name: "GPT-X", description: "d" }]);
    expect(parseCodexModels("not json")).toEqual([]);
  });

  it("Codex: narration becomes thinking, only the last message is the answer; -m and reasoning summaries", () => {
    const events: AgentEvent[] = [];
    class T extends CodexSession {
      argv() { return this.args(); }
      feed(e: Record<string, unknown>) { return this.handle(e); }
    }
    const c = new T({ id: "codex", name: "Codex", protocol: "codex-json", command: "codex.exe", version: "1" }, { cwd: ".", mcp: { command: "n", args: [], env: {} }, model: "gpt-6-luna" }, (e) => events.push(e));
    expect(c.argv()).toEqual(expect.arrayContaining(["-m", "gpt-6-luna", 'model_reasoning_summary="concise"']));
    c.feed({ type: "item.completed", item: { type: "agent_message", text: "Voy a revisar tu bandeja." } });
    c.feed({ type: "item.completed", item: { type: "agent_message", text: "Te falta responder a Ana." } });
    c.feed({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
    expect(events.slice(0, 2)).toEqual([{ type: "thought", text: "Voy a revisar tu bandeja.\n" }, { type: "text", text: "Te falta responder a Ana." }]);
  });

  it("keeps a sane per-agent model choice in preferences", () => {
    const p = sanitizePreferences({ agentModels: { claude: "opus", "bad key!": "x", gemini: "gemini-2.5-pro", codex: 5 }, showThinking: true });
    expect(p.agentModels).toEqual({ claude: "opus", gemini: "gemini-2.5-pro" });
    expect(p.showThinking).toBe(true);
  });
});

describe("tools named by their title (Copilot)", () => {
  it("recognises and auto-approves Wacon tools by title, and the titles match the MCP server", () => {
    expect(waconTool("List recent chats")).toBe("list_chats");
    expect(autoApproval("List recent chats", [{ id: "a", label: "Allow", kind: "allow_once" }, { id: "r", label: "No", kind: "reject_once" }])).toBe("a");
    expect(waconTool("Run shell command")).toBeNull();
    const server = readFileSync(join(__dirname, "../../src/mcp/server.ts"), "utf8");
    for (const name of TUI_TOOLSET) {
      const m = new RegExp(String.raw`registerTool\(\s*"${name}",\s*\{\s*title:\s*"([^"]+)"`).exec(server);
      expect(m?.[1], name).toBe(TOOL_TITLES[name]);
    }
  });
});

describe("handoff, quota, home capsule", () => {
  it("recaps the conversation for the next agent, newest kept", () => {
    const turns = [
      { request: "r1", label: null, text: "a1" },
      { request: "r2", label: "Resumen de hoy", text: "a2 ".repeat(50) },
      { request: "r3", label: null, text: "" },
    ];
    const recap = handoffRecap(turns)!;
    expect(recap).toContain("conversación previa");
    expect(recap).toContain("Resumen de hoy");
    expect(recap.indexOf("r1")).toBeLessThan(recap.indexOf("Resumen de hoy"));
    expect(handoffRecap([])).toBeNull();
  });

  it("recognises quota errors from the agents in the wild", () => {
    expect(isQuotaError("You've hit your 5-hour limit · resets 6:50pm")).toBe(true);
    expect(isQuotaError("429 Too Many Requests")).toBe(true);
    expect(isQuotaError("RESOURCE_EXHAUSTED: quota")).toBe(true);
    expect(isQuotaError("This model is currently experiencing high demand.")).toBe(true);
    expect(isQuotaError("ENOENT")).toBe(false);
  });

  it("the home capsule is a compact inbox, within budget", () => {
    const inbox = Array.from({ length: 100 }, (_, i) => ({ name: `Chat ${i}`, isGroup: i % 2 === 0, unread: i % 3, lastTs: 0, preview: "hola ".repeat(30) }));
    const text = homeCapsule(inbox, 3_600_000, 1500);
    expect(text.length).toBeLessThan(1700);
    expect(text).toContain("todo su WhatsApp");
    expect(text).toContain("grupo Chat 0");
  });
});

describe("native thinking in the panel", () => {
  const theme = resolveTheme(DEFAULT_PREFERENCES).c;
  const base = { id: 1, request: "¿qué pasó?", label: null, tools: [], thinking: "Primero reviso los grupos.\nLuego el inbox.\nDespués las fechas.\nAl final resumo.", startedAt: 0, by: "Gemini" };
  const flat = (l: { text: string }[][]) => l.map((x) => x.map((p) => p.text).join(""));

  it("shows the last reasoning lines live, then folds to one line", () => {
    const live = flat(turnLines({ ...base, text: "", status: "running" }, 60, theme, 0, { showThinking: false, previousBy: null, alternatives: [], now: 5000 }));
    expect(live).toContain("  💭 pensando");
    expect(live.some((l) => l.includes("Al final resumo."))).toBe(true);
    expect(live.some((l) => l.includes("Primero reviso"))).toBe(false); // only the tail while live
    const done = flat(turnLines({ ...base, text: "Todo bien.", status: "done", answeredAt: 8000 }, 60, theme, 0, { showThinking: false, previousBy: null, alternatives: [], now: 9000 }));
    expect(done).toContain("  💭 pensó 8 s · Alt+T ver");
    expect(done.some((l) => l.includes("Primero reviso"))).toBe(false);
    const open = flat(turnLines({ ...base, text: "Todo bien.", status: "done", answeredAt: 8000 }, 60, theme, 0, { showThinking: true, previousBy: null, alternatives: [], now: 9000 }));
    expect(open.some((l) => l.includes("Primero reviso"))).toBe(true);
  });

  it("offers another agent when the quota runs out, and labels the switch", () => {
    const err = flat(turnLines({ ...base, thinking: "", text: "", status: "error", error: "Claude Code alcanzó su límite de uso.", quota: true }, 70, theme, 0, { showThinking: false, previousBy: null, alternatives: ["Gemini CLI", "Codex"], now: 0 }));
    expect(err.join(" ")).toContain("Ctrl+L para seguir con otro modelo u otro agente (Gemini CLI, Codex)");
    const next = flat(turnLines({ ...base, thinking: "", text: "ok", status: "done", by: "Gemini CLI · Flash" }, 70, theme, 0, { showThinking: false, previousBy: "Claude Code · Sonnet", alternatives: [], now: 0 }));
    expect(next[0]).toBe("↻ ahora con Gemini CLI · Flash");
  });
});

// ── controller + app ───────────────────────────────────────

class Runtime implements AgentRuntimePort {
  opened: { agent: string; model?: string }[] = [];
  prompts: string[] = [];
  fail: string | null = null;
  open(a: DetectedAgent, o: AgentSessionOptions, onEvent: (e: AgentEvent) => void): AgentSession {
    this.opened.push({ agent: a.id, model: o.model });
    return {
      prompt: async (text) => {
        this.prompts.push(text);
        if (this.fail) throw new Error(this.fail);
        onEvent({ type: "thought", text: "Reviso el inbox." });
        onEvent({ type: "tool", id: "t", title: "mcp__wacon__get_inbox", input: {}, status: "done" });
        onEvent({ type: "tool", id: "p", title: "propose_reply", input: { chat: "a@lid", text: "Ya te paso el sheet" }, status: "done" });
        onEvent({ type: "text", text: "Te falta responder a Ana." });
      },
      answerPermission: () => undefined,
      cancel: () => undefined,
      close: () => undefined,
    };
  }
  async models(a: DetectedAgent) {
    return a.id === "claude" ? { models: [{ id: "sonnet", name: "Sonnet" }, { id: "haiku", name: "Haiku" }], current: null } : { models: [{ id: "flash", name: "Gemini Flash" }], current: "flash" };
  }
}
const now = Date.now();
const gw = (): ChatGateway =>
  ({
    linkState: async () => ({ state: "connected", selfName: null }), relink: async () => "connected", qr: async () => ({ state: "connected", qr: null }),
    overview: async () => [{ jid: "a@lid", is_group: 0, unread_count: 2, last_message_ts: now, display_name: "Ana", alt_jid: null, last_text: "¿y el sheet?", last_from_me: 0, last_type: "text", last_sender_name: null }],
    messages: async () => [{ id: "m1", chat_jid: "a@lid", sender_jid: "a@lid", from_me: 0, timestamp: now, text: "¿y el sheet?", message_type: "text" }],
    memberNames: async () => ({}), presence: async () => ({ status: "unknown", lastSeenRelative: null }),
    sendText: async () => ({ ok: true, messageId: "s" }), messagesByIds: async () => [], reactions: async () => [], react: async () => ({ ok: true, messageId: "r" }), messageStatuses: async () => [],
    markRead: async () => undefined, waitForMessages: () => new Promise<{ cursor: number; events: IncomingEvent[] }>(() => undefined), currentCursor: async () => 0,
    sendFile: async () => ({ ok: true, messageId: "f" }), fileExists: () => true, fetchMedia: async () => null, openMedia: async () => "ok",
    search: async () => [], stickerMoods: async () => [], stickers: async () => [], sendSticker: async () => ({ ok: true, messageId: "s" }), sendVoice: async () => ({ ok: true, messageId: "v" }),
  }) as unknown as ChatGateway;
const AGENTS: DetectedAgent[] = [
  { id: "claude", name: "Claude Code", protocol: "claude-stream", command: "c", version: "2" },
  { id: "gemini", name: "Gemini CLI", protocol: "acp", command: "g", version: "0.47" },
];
async function setup(prefs: Preferences = { ...DEFAULT_PREFERENCES, agent: "claude" }) {
  let saved = prefs;
  const ultra = new UltraController(gw(), Date.now, { load: () => saved, save: (p) => void (saved = p), location: () => "x" });
  const runtime = new Runtime();
  const agent = new AgentController(ultra, { detect: async () => AGENTS }, runtime, () => ({ cwd: "/tmp", mcp: { command: "n", args: [], env: {} } }));
  await ultra.start();
  await agent.detect();
  return { ultra, agent, runtime };
}
const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));

describe("AgentController: home, models, handoff", () => {
  it("with no chat open, asks over the whole WhatsApp; the home draft keeps its chat", async () => {
    const { agent, runtime } = await setup();
    await agent.ask("¿qué me falta responder?");
    expect(runtime.prompts[0]).toContain("TODO su WhatsApp");
    expect(runtime.prompts[0]).toContain("chat Ana · 2 sin leer");
    const home = agent.chat("__home__");
    expect(home.turns[0]).toMatchObject({ status: "done", text: "Te falta responder a Ana.", thinking: "Reviso el inbox.", by: "Claude Code" });
    expect(home.draft).toEqual({ chatJid: "a@lid", text: "Ya te paso el sheet", replyTo: null });
  });

  it("out of quota → switch agent and model: the new one gets the conversation so far", async () => {
    const { agent, runtime, ultra } = await setup();
    await agent.ask("resumen de hoy");
    runtime.fail = "You've hit your 5-hour limit · resets 6:50pm";
    await agent.ask("¿y mañana?");
    const failed = agent.chat("__home__").turns.at(-1)!;
    expect(failed).toMatchObject({ status: "error", quota: true });
    expect(failed.error).toContain("se renueva 6:50pm");

    runtime.fail = null;
    await agent.loadModels("gemini");
    expect(agent.getState().models.gemini).toMatchObject({ phase: "ready", current: "flash" });
    agent.choose("gemini", "flash");
    expect(ultra.getState().prefs).toMatchObject({ agent: "gemini", agentModels: { gemini: "flash" } });
    await agent.ask("¿y mañana?");
    expect(runtime.opened.at(-1)).toEqual({ agent: "gemini", model: "flash" });
    const handoff = runtime.prompts.at(-1)!;
    expect(handoff).toContain("conversación previa con otro asistente");
    expect(handoff).toContain("resumen de hoy");
    expect(agent.chat("__home__").turns.at(-1)!.by).toBe("Gemini CLI · Gemini Flash");
  });
});

describe("home screen in the app", () => {
  const ESC = "\x1b";
  const CTRL_L = "\x0c";
  const ENTER = "\r";
  const RIGHT = "\x1b[C";
  const DOWN = "\x1b[B";

  it("greets with the AI ready and day-to-day cards; 1 runs one; Ctrl+L → model", async () => {
    const { ultra, agent, runtime } = await setup();
    const ui = render(<App controller={ultra} files={{ complete: () => [], exists: () => true, home: () => "/" }} agent={agent} />);
    await settle(150);
    let frame = ui.lastFrame() ?? "";
    expect(frame).toContain("Claude Code está listo para ayudarte");
    expect(frame).toContain("Resumen de hoy");
    expect(frame).toContain("¿Qué me falta responder?");
    expect(frame).toContain("Sheets y formularios");
    expect(frame).toContain("Tab para preguntarle a tu IA");
    expect(frame).toContain("HOY");
    expect(frame).toContain("1 chat sin leer: Ana");

    ui.stdin.write("2"); // from the chat list, a digit runs the home card
    await settle(150);
    expect(runtime.prompts[0]).toContain("get_inbox");
    frame = ui.lastFrame() ?? "";
    expect(frame).toContain("Te falta responder a Ana.");
    expect(frame).toContain("💭 pensó");
    expect(frame).toContain("Borrador para Ana");

    ui.stdin.write(CTRL_L);
    await settle(120);
    expect(ui.lastFrame()).toContain("elige tu agente");
    ui.stdin.write(RIGHT); // models of Claude Code
    await settle(120);
    frame = ui.lastFrame() ?? "";
    expect(frame).toContain("elige el modelo");
    expect(frame).toContain("Predeterminado del agente");
    expect(frame).toContain("Haiku");
    ui.stdin.write(DOWN);
    ui.stdin.write(DOWN);
    await settle();
    ui.stdin.write(ENTER); // Haiku
    await settle(120);
    expect(ultra.getState().prefs.agentModels).toEqual({ claude: "haiku" });
    expect(ui.lastFrame()).toContain("Haiku ▾");

    ui.stdin.write(ESC);
    ultra.stop();
    agent.stop();
    ui.unmount();
  });
});
