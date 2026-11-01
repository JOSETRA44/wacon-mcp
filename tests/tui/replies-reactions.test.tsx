import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import type { WAMessage } from "@whiskeysockets/baileys";
import { Store, type MessageRow } from "../../src/core/store.js";
import { WhatsAppConnection, extractText } from "../../src/core/connection.js";
import { summarizeReactions } from "../../src/tui/domain/message.js";
import { UltraController } from "../../src/tui/application/controller.js";
import type { ChatGateway, IncomingEvent, RawMessage, SendOutcome } from "../../src/tui/application/ports.js";
import type { RawReaction } from "../../src/tui/domain/message.js";
import { App } from "../../src/tui/presentation/App.js";

let seq = 0;
const m = (over: Partial<MessageRow>): MessageRow => ({
  id: `m${seq++}`, chat_jid: "a@s.whatsapp.net", sender_jid: null, from_me: 0, timestamp: 1, text: "hola", message_type: "text", quoted_id: null, ...over,
});

describe("daemon: quotes and reactions are captured", () => {
  it("a reply quote is read from ANY message kind, not only text", () => {
    const photoReply = { key: { remoteJid: "a@s.whatsapp.net", id: "x" }, message: { imageMessage: { caption: "mira", contextInfo: { stanzaId: "Q1" } } } } as unknown as WAMessage;
    const voiceReply = { key: { remoteJid: "a@s.whatsapp.net", id: "y" }, message: { audioMessage: { ptt: true, contextInfo: { stanzaId: "Q2" } } } } as unknown as WAMessage;
    expect(extractText(photoReply).quotedId).toBe("Q1");
    expect(extractText(voiceReply).quotedId).toBe("Q2");
  });

  it("stores reactions per (message, person); a newer one replaces, an empty one removes, an older one is ignored", () => {
    const store = new Store(":memory:");
    const base = { chatJid: "g@g.us", targetId: "T", senderJid: "ana@s.whatsapp.net", fromMe: false };
    store.upsertReaction({ ...base, emoji: "👍", timestamp: 10 });
    store.upsertReaction({ ...base, emoji: "❤️", timestamp: 20 });
    store.upsertReaction({ ...base, emoji: "😂", timestamp: 15 }); // late history event
    expect(store.reactionsFor(["g@g.us"], ["T"]).map((r) => r.emoji)).toEqual(["❤️"]);
    store.upsertReaction({ ...base, emoji: "", timestamp: 30 });
    expect(store.reactionsFor(["g@g.us"], ["T"])).toEqual([]);
    store.close();
  });

  it("the connection turns a WhatsApp reaction message into a reaction row", () => {
    const store = new Store(":memory:");
    const conn = new WhatsAppConnection(store);
    const msg = {
      key: { remoteJid: "g@g.us", id: "R1", fromMe: false, participant: "luis@s.whatsapp.net" },
      messageTimestamp: 100,
      message: { reactionMessage: { key: { id: "TARGET" }, text: "😂", senderTimestampMs: 100_000 } },
    } as unknown as WAMessage;
    (conn as unknown as { captureReaction: (m: WAMessage) => void }).captureReaction(msg);
    expect(store.reactionsFor(["g@g.us"], ["TARGET"])).toEqual([{ target_id: "TARGET", sender_jid: "luis@s.whatsapp.net", from_me: 0, emoji: "😂" }]);
    store.close();
  });

  it("messagesByIds finds a quoted message in the twin chat too, preferring the asked one", () => {
    const store = new Store(":memory:");
    store.insertMessage(m({ id: "Q", chat_jid: "1@lid", text: "en el lid" }));
    expect(store.messagesByIds(["Q", "nope"], ["51@s.whatsapp.net"]).map((r) => r.text)).toEqual(["en el lid"]);
    store.close();
  });

  it("pills group by emoji, most used first, and mark yours", () => {
    const r = (emoji: string, fromMe = false): RawReaction => ({ targetId: "T", senderJid: "x", fromMe, emoji });
    expect(summarizeReactions([r("😂"), r("❤️"), r("❤️", true)]).get("T")).toEqual([
      { emoji: "❤️", count: 2, mine: true },
      { emoji: "😂", count: 1, mine: false },
    ]);
  });
});

// ── app level ──
const raw = (id: string, ts: number, over: Partial<RawMessage> = {}): RawMessage => ({ id, chat_jid: "a@s.whatsapp.net", sender_jid: "a@s.whatsapp.net", from_me: 0, timestamp: ts, text: `texto ${id}`, message_type: "text", ...over });

function gateway(over: Partial<ChatGateway> = {}) {
  const calls = { sent: [] as { text: string; replyTo?: string }[], reacted: [] as string[], byIds: [] as string[][] };
  const g: ChatGateway = {
    linkState: async () => ({ state: "connected", selfName: null }), relink: async () => "connected", qr: async () => ({ state: "connected", qr: null }),
    overview: async () => [{ jid: "a@s.whatsapp.net", is_group: 0, unread_count: 0, last_message_ts: 10, display_name: "Ana", alt_jid: null, last_text: "x", last_from_me: 0, last_type: "text", last_sender_name: null }],
    messages: async () => [raw("m1", 1), raw("m2", 2, { quoted_id: "OLD" })],
    memberNames: async () => ({}), presence: async () => ({ status: "unknown", lastSeenRelative: null }),
    sendText: async (_j, text, replyTo) => (calls.sent.push({ text, replyTo }), { ok: true, messageId: "srv" } as SendOutcome),
    sendFile: async () => ({ ok: true, messageId: "f" }), markRead: async () => undefined,
    waitForMessages: () => new Promise<{ cursor: number; events: IncomingEvent[] }>(() => undefined), currentCursor: async () => 0, openMedia: async () => "", fileExists: () => true,
    search: async () => [], stickerMoods: async () => [], stickers: async () => [], sendSticker: async () => ({ ok: true, messageId: "s" }), sendVoice: async () => ({ ok: true, messageId: "v" }),
    messagesByIds: async (_j, ids) => (calls.byIds.push(ids), ids.includes("OLD") ? [raw("OLD", 0, { text: "lo de hace un mes" })] : []),
    reactions: async () => [{ targetId: "m1", senderJid: "a@s.whatsapp.net", fromMe: false, emoji: "😂" }],
    react: async (_j, id, emoji) => (calls.reacted.push(`${id}:${emoji}`), { ok: true, messageId: "r" }),
    ...over,
  };
  return { g, calls };
}
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

describe("controller: replies and reactions", () => {
  it("fetches quoted messages that are not loaded, once", async () => {
    const { g, calls } = gateway();
    const c = new UltraController(g);
    await c.start();
    await c.openChat("a@s.whatsapp.net");
    await settle(10);
    expect(calls.byIds).toEqual([["OLD"]]);
    expect(c.getState().conversations["a@s.whatsapp.net"]!.quoted.OLD?.text).toBe("lo de hace un mes");
    expect(c.getState().conversations["a@s.whatsapp.net"]!.reactions).toHaveLength(1);
    c.stop();
  });

  it("a reply carries the quote locally and to the daemon", async () => {
    const { g, calls } = gateway();
    const c = new UltraController(g);
    await c.start();
    await c.openChat("a@s.whatsapp.net");
    await c.sendText("sí, eso", "m1");
    expect(calls.sent).toEqual([{ text: "sí, eso", replyTo: "m1" }]);
    expect(c.getState().conversations["a@s.whatsapp.net"]!.messages.at(-1)).toMatchObject({ quotedId: "m1", status: "sent" });
    c.stop();
  });

  it("reacting is instant; the same emoji again removes it; a refusal rolls back", async () => {
    const { g, calls } = gateway();
    const c = new UltraController(g);
    await c.start();
    await c.openChat("a@s.whatsapp.net");
    await settle(10);
    const mine = () => c.getState().conversations["a@s.whatsapp.net"]!.reactions.filter((r) => r.fromMe).map((r) => r.emoji);
    await c.react("m1", "❤️");
    expect(mine()).toEqual(["❤️"]);
    await c.react("m1", "❤️");
    expect(mine()).toEqual([]);
    expect(calls.reacted).toEqual(["m1:❤️", "m1:"]);
    g.react = async () => ({ ok: false, reason: "sin conexión" });
    await c.react("m1", "👍");
    expect(mine()).toEqual([]);
    expect(c.getState().notice?.text).toMatch(/sin conexión/);
    c.stop();
  });
});

describe("app: the message menu", () => {
  it("↑ selects messages, r replies (bar shows the quote), ↵ sends quoting it", async () => {
    const { g, calls } = gateway();
    const c = new UltraController(g);
    const ui = render(<App controller={c} files={{ complete: () => [], exists: () => true, home: () => "/" }} />);
    await c.start();
    await settle();
    ui.stdin.write(String.fromCharCode(13)); // open Ana
    await settle();
    ui.stdin.write("\x1b[A"); // ↑ on empty composer → last message (m2)
    await settle();
    ui.stdin.write("\x1b[A"); // ↑ again → m1
    await settle();
    ui.stdin.write("r");
    await settle();
    expect(ui.lastFrame() ?? "").toContain("Esc cancela");
    expect(ui.lastFrame() ?? "").toContain("texto m1");
    for (const ch of "ok") ui.stdin.write(ch);
    ui.stdin.write(String.fromCharCode(13));
    await settle();
    expect(calls.sent).toEqual([{ text: "ok", replyTo: "m1" }]);
    expect(ui.lastFrame() ?? "").not.toContain("Esc cancela");
    c.stop();
    ui.unmount();
  });

  it("shows reaction pills and the quote block in bubbles", async () => {
    const { g } = gateway();
    const c = new UltraController(g);
    const ui = render(<App controller={c} files={{ complete: () => [], exists: () => true, home: () => "/" }} />);
    await c.start();
    await settle();
    ui.stdin.write(String.fromCharCode(13));
    await settle(120);
    const frame = ui.lastFrame() ?? "";
    expect(frame).toContain("😂");
    expect(frame).toContain("lo de hace un mes");
    c.stop();
    ui.unmount();
  });
});
