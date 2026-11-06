import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { Store } from "../../src/core/store.js";
import { agendaDayLabel, agendaSummary, buildAgenda, proposalFrom, proposalLine } from "../../src/tui/domain/agenda.js";
import { foldIdentities, toSummary } from "../../src/tui/domain/chat.js";
import { AgendaController } from "../../src/tui/application/agenda-controller.js";
import { AgentController } from "../../src/tui/application/agent-controller.js";
import { UltraController } from "../../src/tui/application/controller.js";
import type { AgendaData, AgendaGateway, AgentRuntimePort, AgentSession, ChatGateway, IncomingEvent } from "../../src/tui/application/ports.js";
import type { AgentEvent, DetectedAgent } from "../../src/tui/domain/agent.js";
import { DEFAULT_PREFERENCES } from "../../src/tui/domain/preferences.js";
import { App } from "../../src/tui/presentation/App.js";

const NOW = new Date(2026, 10, 3, 9, 0).getTime(); // Tue 3 Nov 2026, 09:00
const at = (d: number, h = 10) => new Date(2026, 10, d, h, 0).getTime();

describe("agenda domain", () => {
  it("labels days the way people say them", () => {
    expect(agendaDayLabel(at(3), NOW)).toBe("Hoy");
    expect(agendaDayLabel(at(4), NOW)).toBe("Mañana");
    expect(agendaDayLabel(at(6), NOW)).toMatch(/^viernes 6/);
    expect(agendaDayLabel(at(20), NOW)).toMatch(/^20/);
  });

  it("orders overdue → days → undated, drops past events and cancelled ones", () => {
    const sections = buildAgenda(
      [
        { id: 1, title: "Examen", startTs: at(4, 8), chatJid: "g@g.us", status: "scheduled", notes: null },
        { id: 2, title: "Ya pasó", startTs: at(1), chatJid: null, status: "fired", notes: null },
        { id: 3, title: "Reunión", startTs: at(3, 18), chatJid: null, status: "scheduled", notes: null },
        { id: 4, title: "Cancelada", startTs: at(5), chatJid: null, status: "cancelled", notes: null },
      ],
      [
        { id: 10, title: "Llenar sheet", dueTs: at(2), chatJid: null, notes: null },
        { id: 11, title: "Comprar pasajes", dueTs: null, chatJid: null, notes: null },
        { id: 12, title: "Entregar informe", dueTs: at(4, 23), chatJid: null, notes: null },
      ],
      NOW
    );
    expect(sections.map((s) => [s.label, s.items.map((i) => i.title)])).toEqual([
      ["Vencidas", ["Llenar sheet"]],
      ["Hoy", ["Reunión"]],
      ["Mañana", ["Examen", "Entregar informe"]],
      ["Sin fecha", ["Comprar pasajes"]],
    ]);
    expect(agendaSummary(sections, NOW)).toBe("1 vencida · Hoy 18:00 · Reunión");
    expect(agendaSummary([], NOW)).toContain("Nada pendiente");
  });

  it("turns propose_event / propose_task calls into cards; an event needs a real date", () => {
    expect(proposalFrom("propose_event", { title: "Parcial", start: "2026-11-05T10:00:00", chat: "g@g.us" })).toEqual({ kind: "event", title: "Parcial", when: "2026-11-05T10:00:00", chatJid: "g@g.us", notes: null });
    expect(proposalFrom("propose_event", { title: "Sin fecha" })).toBeNull();
    expect(proposalFrom("propose_task", { title: "Llenar sheet", due: "no es fecha" })).toMatchObject({ kind: "task", when: null });
    expect(proposalFrom("read_messages", { title: "x" })).toBeNull();
    expect(proposalLine({ kind: "event", title: "Parcial", when: "2026-11-04T10:00:00", chatJid: null, notes: null }, NOW)).toBe("📅 Mañana 10:00 · Parcial");
  });
});

describe("archived chats", () => {
  it("are stored on both halves of a @lid/phone pair and fold as archived", () => {
    const s = new Store(":memory:");
    s.mapJids("111@lid", "51999@s.whatsapp.net");
    s.upsertChat({ jid: "111@lid", name: "Ana", lastMessageTs: 2 });
    s.upsertChat({ jid: "51999@s.whatsapp.net", lastMessageTs: 1 });
    s.setArchived("51999@s.whatsapp.net", true);
    expect(s.archivedCount()).toBe(2);
    const rows = s.chatOverview();
    expect(rows.every((r) => r.archived === 1)).toBe(true);
    expect(foldIdentities(rows.map(toSummary))).toMatchObject([{ jid: "111@lid", archived: true }]);
    s.setArchived("111@lid", false);
    expect(s.archivedCount()).toBe(0);
  });
});

// ── the app ────────────────────────────────────────────────

class FakeAgenda implements AgendaGateway {
  data: AgendaData = {
    // Tomorrow 10:00: a fixed hour keeps the row text the same whatever day the tests run.
    events: [{ id: 1, title: "Examen de Micro", startTs: (() => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(10, 0, 0, 0); return d.getTime(); })(), chatJid: "g@g.us", status: "scheduled", notes: null }],
    tasks: [{ id: 7, title: "Llenar el sheet de asistencia", dueTs: null, chatJid: null, notes: null }],
    staleSuggestions: 152,
    commitments: [{ chatJid: "a@lid", name: "Ana", text: "te mando el informe mañana", ageDays: 2 }],
  };
  done: string[] = [];
  async agenda() { return structuredClone(this.data); }
  async scheduleEvent(i: { title: string; start: string }) { this.data.events.push({ id: 99, title: i.title, startTs: new Date(i.start).getTime(), chatJid: null, status: "scheduled", notes: null }); }
  async addTask(i: { title: string }) { this.data.tasks.push({ id: 100, title: i.title, dueTs: null, chatJid: null, notes: null }); }
  async completeEvent(id: number) { this.done.push(`e${id}`); this.data.events = this.data.events.filter((e) => e.id !== id); }
  async cancelEvent(id: number) { this.done.push(`c${id}`); }
  async completeTask(id: number) { this.done.push(`t${id}`); this.data.tasks = this.data.tasks.filter((t) => t.id !== id); }
  async dismissStaleSuggestions() { const n = this.data.staleSuggestions; this.data.staleSuggestions = 0; return n; }
}

const now = Date.now();
const gw = (): ChatGateway =>
  ({
    linkState: async () => ({ state: "connected", selfName: null }), relink: async () => "connected", qr: async () => ({ state: "connected", qr: null }),
    overview: async () => [
      { jid: "a@lid", is_group: 0, unread_count: 0, last_message_ts: now, display_name: "Ana", alt_jid: null, last_text: "hola", last_from_me: 0, last_type: "text", last_sender_name: null },
      { jid: "g@g.us", is_group: 1, unread_count: 3, last_message_ts: now - 1000, display_name: "PERU VENTAS", alt_jid: null, last_text: "oferta", last_from_me: 0, last_type: "text", last_sender_name: null, archived: 1 },
    ],
    messages: async () => [], memberNames: async () => ({}), presence: async () => ({ status: "unknown", lastSeenRelative: null }),
    sendText: async () => ({ ok: true, messageId: "s" }), messagesByIds: async () => [], reactions: async () => [], react: async () => ({ ok: true, messageId: "r" }), messageStatuses: async () => [],
    markRead: async () => undefined, waitForMessages: () => new Promise<{ cursor: number; events: IncomingEvent[] }>(() => undefined), currentCursor: async () => 0,
    sendFile: async () => ({ ok: true, messageId: "f" }), fileExists: () => true, fetchMedia: async () => null, openMedia: async () => "ok",
    search: async () => [], stickerMoods: async () => [], stickers: async () => [], sendSticker: async () => ({ ok: true, messageId: "s" }), sendVoice: async () => ({ ok: true, messageId: "v" }),
  }) as unknown as ChatGateway;

class ProposingRuntime implements AgentRuntimePort {
  open(_a: DetectedAgent, _o: unknown, onEvent: (e: AgentEvent) => void): AgentSession {
    return {
      prompt: async () => {
        onEvent({ type: "tool", id: "p1", title: "propose_event", input: { title: "Entrega del TIF", start: new Date(now + 72 * 3600_000).toISOString().slice(0, 19) }, status: "done" });
        onEvent({ type: "text", text: "Encontré una entrega." });
      },
      answerPermission: () => undefined, cancel: () => undefined, close: () => undefined,
    };
  }
  async models() { return { models: [], current: null }; }
}

const settle = (ms = 100) => new Promise((r) => setTimeout(r, ms));
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";

async function setup() {
  let saved = { ...DEFAULT_PREFERENCES, agent: "claude" };
  const ultra = new UltraController(gw(), Date.now, { load: () => saved, save: (p) => void (saved = p), location: () => "x" });
  const fake = new FakeAgenda();
  const agenda = new AgendaController(fake, (t, tone) => ultra.inform(t, tone));
  const agent = new AgentController(ultra, { detect: async () => [{ id: "claude", name: "Claude Code", protocol: "claude-stream", command: "c", version: "2" }] }, new ProposingRuntime(), () => ({ cwd: "/", mcp: { command: "n", args: [], env: {} } }));
  await ultra.start();
  const ui = render(<App controller={ultra} files={{ complete: () => [], exists: () => true, home: () => "/" }} agent={agent} agenda={agenda} />);
  await settle(200);
  return { ultra, agent, agenda, fake, ui };
}

describe("chat list with Wacon IA, Agenda and Archivados", () => {
  it("pins the three rows; archived chats live under Archivados", async () => {
    const { ui, ultra, agent } = await setup();
    let frame = ui.lastFrame() ?? "";
    expect(frame).toContain("Wacon IA");
    expect(frame).toContain("Agenda");
    expect(frame).toContain("Archivados");
    expect(frame).toContain("Mañana 10:00 · Examen"); // the Agenda row previews the next item
    expect(frame).toContain("Ana");
    expect(frame).not.toContain("PERU VENTAS · ");
    // Open Archivados: the archived group shows, Esc goes back.
    ui.stdin.write(DOWN);
    await settle();
    ui.stdin.write(DOWN);
    await settle();
    ui.stdin.write(ENTER);
    await settle();
    frame = ui.lastFrame() ?? "";
    expect(frame).toContain("Volver a los chats");
    expect(frame).toContain("PERU VENTAS");
    ui.stdin.write(ESC);
    await settle();
    expect(ui.lastFrame()).toContain("Wacon IA");
    ultra.stop(); agent.stop(); ui.unmount();
  });

  it("the Agenda pane: d marks done, n adds a task, x clears the 152 stale suggestions", async () => {
    const { ui, ultra, agent, fake } = await setup();
    ui.stdin.write(DOWN); // Agenda row
    await settle();
    ui.stdin.write(ENTER);
    await settle(150);
    let frame = ui.lastFrame() ?? "";
    expect(frame).toContain("📅 Agenda");
    expect(frame).toContain("Examen de Micro");
    expect(frame).toContain("Llenar el sheet de asistencia");
    expect(frame).toContain("152 sugerencias antiguas");
    ui.stdin.write("d"); // first item: the exam
    await settle(150);
    expect(fake.done).toEqual(["e1"]);
    ui.stdin.write("n");
    await settle();
    ui.stdin.write("Pagar la matrícula");
    await settle();
    ui.stdin.write(ENTER);
    await settle(150);
    expect(fake.data.tasks.map((t) => t.title)).toContain("Pagar la matrícula");
    ui.stdin.write("x");
    await settle(150);
    expect(fake.data.staleSuggestions).toBe(0);
    frame = ui.lastFrame() ?? "";
    expect(frame).not.toContain("sugerencias antiguas");
    ultra.stop(); agent.stop(); ui.unmount();
  });

  it("an event the AI proposes is added only when the user presses ↵", async () => {
    const { ui, ultra, agent, fake } = await setup();
    await agent.detect();
    ui.stdin.write(ENTER); // Wacon IA row → home, input focused
    await settle();
    ui.stdin.write("¿qué fechas tengo?");
    await settle();
    ui.stdin.write(ENTER);
    await settle(200);
    expect(ui.lastFrame()).toContain("¿Añadir a tu agenda?");
    expect(ui.lastFrame()).toContain("Entrega del TIF");
    expect(fake.data.events.some((e) => e.title === "Entrega del TIF")).toBe(false);
    ui.stdin.write(ENTER); // accept
    await settle(200);
    expect(fake.data.events.some((e) => e.title === "Entrega del TIF")).toBe(true);
    expect(ui.lastFrame()).not.toContain("¿Añadir a tu agenda?");
    ultra.stop(); agent.stop(); ui.unmount();
  });
});
