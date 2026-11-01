import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { Store, type MessageRow } from "../../src/core/store.js";
import { UltraController } from "../../src/tui/application/controller.js";
import type { ChatGateway, FilePort, IncomingEvent } from "../../src/tui/application/ports.js";
import type { OverviewRow } from "../../src/tui/domain/chat.js";
import { App } from "../../src/tui/presentation/App.js";

let seq = 0;
const m = (over: Partial<MessageRow>): MessageRow => ({
  id: `m${seq++}`, chat_jid: "a@s.whatsapp.net", sender_jid: null, from_me: 0, timestamp: Date.now(), text: "hola", message_type: "text", quoted_id: null, ...over,
});

describe("Store.chatOverview", () => {
  it("returns each chat once with its LAST message, newest chat first, hiding WhatsApp internals", () => {
    const store = new Store(":memory:");
    const t = Date.now();
    store.upsertChat({ jid: "a@s.whatsapp.net", name: "Ana", lastMessageTs: t - 5000 });
    store.upsertChat({ jid: "b@s.whatsapp.net", name: "Beto", lastMessageTs: t - 1000 });
    store.upsertChat({ jid: "status@broadcast", lastMessageTs: t });
    store.upsertChat({ jid: "1203@newsletter", lastMessageTs: t });
    store.insertMessage(m({ chat_jid: "a@s.whatsapp.net", text: "primero", timestamp: t - 9000 }));
    store.insertMessage(m({ chat_jid: "a@s.whatsapp.net", text: "último de Ana", timestamp: t - 5000 }));
    // A later reaction/edit must not become the preview.
    store.insertMessage(m({ chat_jid: "a@s.whatsapp.net", text: null, message_type: "reaction", timestamp: t - 4000 }));
    store.insertMessage(m({ chat_jid: "a@s.whatsapp.net", text: null, message_type: "unknown", timestamp: t - 3000 }));
    store.insertMessage(m({ chat_jid: "b@s.whatsapp.net", text: "ya voy", from_me: 1, timestamp: t - 1000 }));
    // A lid mapping must not duplicate the row.
    store.mapJids("99@lid", "a@s.whatsapp.net");

    const rows = store.chatOverview(10);
    expect(rows.map((r) => r.jid)).toEqual(["b@s.whatsapp.net", "a@s.whatsapp.net"]);
    expect(rows[0]).toMatchObject({ last_text: "ya voy", last_from_me: 1, display_name: "Beto" });
    expect(rows[1]).toMatchObject({ last_text: "último de Ana", alt_jid: "99@lid" });
    store.close();
  });

  it("keeps WhatsApp's unread counter live: bump on arrival, clear on read", () => {
    const store = new Store(":memory:");
    store.upsertChat({ jid: "a@s.whatsapp.net", name: "Ana", lastMessageTs: 1 });
    store.bumpUnread("a@s.whatsapp.net");
    store.bumpUnread("a@s.whatsapp.net");
    expect(store.chatOverview(5)[0]!.unread_count).toBe(2);
    store.clearUnread("a@s.whatsapp.net");
    expect(store.chatOverview(5)[0]!.unread_count).toBe(0);
    store.close();
  });
});

const row = (jid: string, name: string, ts: number, over: Partial<OverviewRow> = {}): OverviewRow => ({
  jid, is_group: 0, unread_count: 0, last_message_ts: ts, display_name: name, alt_jid: null, last_text: "hola", last_from_me: 0, last_type: "text", last_sender_name: null, ...over,
});

function fakeGateway(over: Partial<ChatGateway> = {}): ChatGateway {
  return {
    linkState: async () => ({ state: "connected", selfName: null }),
    relink: async () => "connected",
    qr: async () => ({ state: "connected", qr: null }),
    overview: async () => [row("a@s.whatsapp.net", "Ana Torres", Date.now() - 60_000, { unread_count: 3 }), row("b@s.whatsapp.net", "Beto", Date.now() - 86_400_000, { last_text: "ok", last_from_me: 1 })],
    messages: async () => [],
    memberNames: async () => ({}),
    presence: async () => ({ status: "unknown", lastSeenRelative: null }),
    sendText: async () => ({ ok: true, messageId: "x" }),
    sendFile: async () => ({ ok: true, messageId: "y" }),
    markRead: async () => undefined,
    waitForMessages: () => new Promise<{ cursor: number; events: IncomingEvent[] }>(() => undefined),
    currentCursor: async () => 0,
    openMedia: async () => "",
    fileExists: () => true,
    ...over,
  };
}
const files: FilePort = { complete: () => [], exists: () => true, home: () => "/home/me/" };
const ENTER = String.fromCharCode(13);
const settle = () => new Promise((r) => setTimeout(r, 60));

describe("App render", () => {
  it("draws the WhatsApp-style list: newest first, preview, unread badge", async () => {
    const c = new UltraController(fakeGateway());
    const ui = render(<App controller={c} files={files} />);
    await c.start();
    await settle();
    const frame = ui.lastFrame() ?? "";
    expect(frame).toContain("Chats");
    expect(frame.indexOf("Ana Torres")).toBeLessThan(frame.indexOf("Beto"));
    expect(frame).toContain("Tú: ok");
    expect(frame).toMatch(/hola\s+3\s*$/m);
    expect(frame).toContain("ayer");
    c.stop();
    ui.unmount();
  });

  it("typing in the list filters it instantly", async () => {
    const c = new UltraController(fakeGateway());
    const ui = render(<App controller={c} files={files} />);
    await c.start();
    await settle();
    ui.stdin.write("bet");
    await settle();
    const frame = ui.lastFrame() ?? "";
    expect(frame).toContain("Beto");
    expect(frame).not.toContain("Ana Torres");
    c.stop();
    ui.unmount();
  });

  it("Enter right after fast typing sends the whole text (no stale draft), and failures stay visible", async () => {
    const sent: string[] = [];
    const c = new UltraController(fakeGateway({ sendText: async (_j, t) => (sent.push(t), { ok: false, reason: "sin conexión" }) }));
    const ui = render(<App controller={c} files={files} />);
    await c.start();
    await settle();
    ui.stdin.write(ENTER); // open the selected (newest) chat
    await settle();
    for (const ch of "llego en 5") ui.stdin.write(ch);
    ui.stdin.write(ENTER); // same tick as the last key — no re-render in between
    await settle();
    expect(sent).toEqual(["llego en 5"]);
    expect(ui.lastFrame() ?? "").toContain("no enviado · Ctrl+R reintenta");
    c.stop();
    ui.unmount();
  });

  it("/voz in the composer sends a voice note instead of text", async () => {
    const voices: string[] = [];
    const texts: string[] = [];
    const c = new UltraController(fakeGateway({
      sendVoice: async (_j, t) => (voices.push(t), { ok: true, messageId: "v", seconds: 3 }),
      sendText: async (_j, t) => (texts.push(t), { ok: true, messageId: "t" }),
    }));
    const ui = render(<App controller={c} files={files} />);
    await c.start();
    await settle();
    ui.stdin.write(ENTER);
    await settle();
    for (const ch of "/voz ya voy") ui.stdin.write(ch);
    await settle();
    expect(ui.lastFrame() ?? "").toContain("nota de voz");
    ui.stdin.write(ENTER);
    await settle();
    expect(voices).toEqual(["ya voy"]);
    expect(texts).toEqual([]);
    c.stop();
    ui.unmount();
  });

  it("without a session shows the linking steps instead of an empty app", async () => {
    let calls = 0;
    const c = new UltraController(
      fakeGateway({
        linkState: async () => ({ state: "logged_out", selfName: null }),
        qr: async () => ({ state: calls++ > 50 ? "connected" : "waiting_qr", qr: "2@abcdef" }),
      })
    );
    const ui = render(<App controller={c} files={files} />);
    void c.start();
    await settle();
    expect(ui.lastFrame() ?? "").toContain("Dispositivos vinculados");
    c.stop();
    ui.unmount();
  });
});
