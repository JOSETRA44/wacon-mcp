import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitmentsFor, profileNotes, styleSentence, todayLines } from "../../src/tui/domain/contact.js";
import { AgentController } from "../../src/tui/application/agent-controller.js";
import { UltraController } from "../../src/tui/application/controller.js";
import type { AgentHistory, AgentHistoryPort, AgentRuntimePort, AgentSession, AgentSessionOptions, ChatGateway, ContactInfoPort, IncomingEvent } from "../../src/tui/application/ports.js";
import type { AgentEvent, DetectedAgent } from "../../src/tui/domain/agent.js";
import { DEFAULT_PREFERENCES } from "../../src/tui/domain/preferences.js";
import { AgentHistoryFile } from "../../src/tui/infrastructure/agent-history-file.js";
import { App } from "../../src/tui/presentation/App.js";

describe("contact domain", () => {
  it("keeps only real profile notes, skipping the template placeholders", () => {
    const body = "## Dinámica\n_(Cómo es la relación...)_\n- Amiga de la universidad, responde rápido\n\n## Qué evitar\n_(…)_\n\n## Temas recurrentes\nExámenes y el viaje a Cusco";
    expect(profileNotes(body)).toEqual([
      { section: "Dinámica", lines: ["Amiga de la universidad, responde rápido"] },
      { section: "Temas recurrentes", lines: ["Exámenes y el viaje a Cusco"] },
    ]);
    expect(profileNotes(null)).toEqual([]);
  });

  it("describes how you write to someone, from the analyzer's stats", () => {
    expect(styleSentence({ messageCount: 80, avgMessageLength: 18, formality: "casual", topEmojis: [{ emoji: "😂" }, { emoji: "🙏" }], laughterStyle: "jaja" })).toBe("Le escribes: mensajes cortos, tono informal, emojis 😂🙏, ríes con «jaja».");
    expect(styleSentence({ messageCount: 2 })).toBeNull();
  });

  it("the home's Hoy lines come from local data", () => {
    const lines = todayLines({
      unread: [{ name: "Ana", unread: 2 }, { name: "Grupo", unread: 0 }, { name: "Luis", unread: 1 }],
      agendaToday: ["10:00 Examen"],
      commitments: [{ chatJid: "a", name: "Ana", text: "te mando el informe", ageDays: 2 }],
    });
    expect(lines).toEqual(["💬 2 chats sin leer: Ana, Luis", "📅 Hoy: 10:00 Examen", "⏳ Prometiste a Ana: «te mando el informe» (hace 2 d)"]);
    expect(commitmentsFor([{ chatJid: "x@lid", name: null, text: "t", ageDays: 1 }], ["x@lid"])).toHaveLength(1);
  });
});

// ── history, resume, quota ─────────────────────────────────

class MemHistory implements AgentHistoryPort {
  h: AgentHistory = { chats: {}, sessions: {}, quota: {} };
  load() { return structuredClone(this.h); }
  save(h: AgentHistory) { this.h = structuredClone(h); }
}
class Runtime implements AgentRuntimePort {
  opened: AgentSessionOptions[] = [];
  prompts: string[] = [];
  fail: string | null = null;
  open(_a: DetectedAgent, o: AgentSessionOptions, onEvent: (e: AgentEvent) => void): AgentSession {
    this.opened.push(o);
    return {
      prompt: async (t) => {
        this.prompts.push(t);
        if (this.fail) throw new Error(this.fail);
        onEvent({ type: "session", sessionId: "sess-42" });
        onEvent({ type: "text", text: "Respuesta." });
      },
      answerPermission: () => undefined, cancel: () => undefined, close: () => undefined,
    };
  }
  async models() { return { models: [], current: null }; }
}
const now = Date.now();
const gw = (): ChatGateway =>
  ({
    linkState: async () => ({ state: "connected", selfName: null }), relink: async () => "connected", qr: async () => ({ state: "connected", qr: null }),
    overview: async () => [{ jid: "a@lid", is_group: 0, unread_count: 0, last_message_ts: now, display_name: "Ana", alt_jid: null, last_text: "hola", last_from_me: 0, last_type: "text", last_sender_name: null }],
    messages: async () => [{ id: "m1", chat_jid: "a@lid", sender_jid: "a@lid", from_me: 0, timestamp: now, text: "hola", message_type: "text" }],
    memberNames: async () => ({}), presence: async () => ({ status: "unknown", lastSeenRelative: null }),
    sendText: async () => ({ ok: true, messageId: "s" }), messagesByIds: async () => [], reactions: async () => [], react: async () => ({ ok: true, messageId: "r" }), messageStatuses: async () => [],
    markRead: async () => undefined, waitForMessages: () => new Promise<{ cursor: number; events: IncomingEvent[] }>(() => undefined), currentCursor: async () => 0,
    sendFile: async () => ({ ok: true, messageId: "f" }), fileExists: () => true, fetchMedia: async () => null, openMedia: async () => "ok",
    search: async () => [], stickerMoods: async () => [], stickers: async () => [], sendSticker: async () => ({ ok: true, messageId: "s" }), sendVoice: async () => ({ ok: true, messageId: "v" }),
  }) as unknown as ChatGateway;

async function make(agent: DetectedAgent, history: MemHistory, runtime = new Runtime()) {
  let saved = { ...DEFAULT_PREFERENCES, agent: agent.id };
  const ultra = new UltraController(gw(), Date.now, { load: () => saved, save: (p) => void (saved = p), location: () => "x" });
  const ctrl = new AgentController(ultra, { detect: async () => [agent] }, runtime, () => ({ cwd: "/", mcp: { command: "n", args: [], env: {} } }), history);
  await ultra.start();
  await ctrl.detect();
  return { ultra, ctrl, runtime };
}
const CLAUDE: DetectedAgent = { id: "claude", name: "Claude Code", protocol: "claude-stream", command: "c", version: "2" };
const GEMINI: DetectedAgent = { id: "gemini", name: "Gemini CLI", protocol: "acp", command: "g", version: "1" };

describe("Modo IA survives a restart", () => {
  it("a chat's conversation comes back, and Claude resumes its own session with only what is new", async () => {
    const history = new MemHistory();
    const first = await make(CLAUDE, history);
    await first.ultra.openChat("a@lid");
    await first.ctrl.ask("¿qué quiere Ana?");
    expect(history.h.chats["a@lid"]).toHaveLength(1);
    expect(history.h.sessions["a@lid"]).toMatchObject({ agentId: "claude", sessionId: "sess-42" });

    // New run of the app.
    const second = await make(CLAUDE, history);
    expect(second.ctrl.chat("a@lid").turns[0]).toMatchObject({ request: "¿qué quiere Ana?", text: "Respuesta.", status: "done" });
    await second.ultra.openChat("a@lid");
    await second.ctrl.ask("¿y ahora?");
    expect(second.runtime.opened[0]!.resumeSessionId).toBe("sess-42");
    expect(second.runtime.prompts[0]).toBe("Petición del usuario: ¿y ahora?"); // no brief, no capsule: it remembers
  });

  it("an ACP agent cannot resume: it gets the brief plus a recap of the stored conversation", async () => {
    const history = new MemHistory();
    const first = await make(GEMINI, history);
    await first.ultra.openChat("a@lid");
    await first.ctrl.ask("resume el chat");
    const second = await make(GEMINI, history);
    await second.ultra.openChat("a@lid");
    await second.ctrl.ask("¿algo más?");
    expect(second.runtime.opened[0]!.resumeSessionId).toBeUndefined();
    expect(second.runtime.prompts[0]).toContain("conversación previa con otro asistente");
    expect(second.runtime.prompts[0]).toContain("resume el chat");
  });

  it("remembers a quota hit (picker warns) until the agent works again", async () => {
    const history = new MemHistory();
    const { ctrl, runtime, ultra } = await make(CLAUDE, history);
    runtime.fail = "You've hit your 5-hour limit · resets 6:50pm";
    await ultra.openChat("a@lid");
    await ctrl.ask("hola");
    expect(ctrl.quotaFor("claude")?.message).toContain("se renueva 6:50pm");
    expect(ctrl.quotaFor("claude", null)).not.toBeNull();
    runtime.fail = null;
    await ctrl.ask("hola otra vez");
    expect(ctrl.quotaFor("claude")).toBeNull();
  });

  it("the history file round-trips and tolerates garbage", () => {
    const dir = mkdtempSync(join(tmpdir(), "wacon-hist-"));
    const f = new AgentHistoryFile(dir);
    expect(f.load()).toEqual({ chats: {}, sessions: {}, quota: {} });
    f.save({ chats: { x: [{ request: "r", label: null, text: "t", thinking: "", by: "C", status: "done", at: 1 }] }, sessions: {}, quota: {} });
    expect(f.load().chats.x).toHaveLength(1);
  });
});

describe("Alt+I contact panel", () => {
  it("shows facts, notes and promises without asking any AI", async () => {
    const history = new MemHistory();
    const { ultra, ctrl } = await make(CLAUDE, history);
    const contacts: ContactInfoPort = {
      contactInfo: async () => ({ facts: [{ category: "gustos", fact: "el café de altura" }], tags: ["universidad"], notes: [{ section: "Dinámica", lines: ["Amiga cercana"] }], style: "Le escribes: mensajes cortos." }),
      commitments: async () => [],
    };
    const ui = render(<App controller={ultra} files={{ complete: () => [], exists: () => true, home: () => "/" }} agent={ctrl} contacts={contacts} />);
    await new Promise((r) => setTimeout(r, 120));
    ui.stdin.write("\x1b[B"); // Ana (below the Wacon IA row)
    await new Promise((r) => setTimeout(r, 60));
    ui.stdin.write("\r");
    await new Promise((r) => setTimeout(r, 100));
    ui.stdin.write("\x1bi"); // Alt+I
    await new Promise((r) => setTimeout(r, 150));
    const frame = ui.lastFrame() ?? "";
    expect(frame).toContain("ⓘ Ana");
    expect(frame).toContain("le gusta: el café de altura");
    expect(frame).toContain("Amiga cercana");
    expect(frame).toContain("Le escribes: mensajes cortos.");
    ultra.stop(); ctrl.stop(); ui.unmount();
  });
});
