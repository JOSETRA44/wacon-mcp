import { describe, it, expect } from "vitest";
import { UltraController } from "../../src/tui/application/controller.js";
import type { ChatGateway, IncomingEvent, RawMessage, SendOutcome } from "../../src/tui/application/ports.js";
import type { OverviewRow } from "../../src/tui/domain/chat.js";

/** In-memory gateway: the controller is tested without a daemon or a terminal. */
class FakeGateway implements ChatGateway {
  state: "connected" | "logged_out" = "connected";
  qrs: (string | null)[] = [];
  rows: OverviewRow[] = [];
  history: Record<string, RawMessage[]> = {};
  sendResult: SendOutcome = { ok: true, messageId: "srv-1" };
  sendGate: Promise<void> = Promise.resolve();
  delays: Record<string, number> = {};
  marked: string[] = [];

  async linkState() { return { state: this.state, selfName: "José" }; }
  async relink() { return this.state; }
  async qr() {
    const q = this.qrs.shift();
    if (q === undefined) this.state = "connected";
    return { state: this.state === "connected" ? ("connected" as const) : ("waiting_qr" as const), qr: q ?? null };
  }
  async overview() { return this.rows; }
  async messages(jid: string, _limit?: number, beforeTs?: number) {
    await new Promise((r) => setTimeout(r, this.delays[jid] ?? 0));
    // Paged history: each older page is everything strictly before beforeTs.
    const all = [...(this.history[jid] ?? []), ...(this.pages[jid] ?? []).flat()].sort((a, b) => b.timestamp - a.timestamp);
    const older = beforeTs === undefined ? all : all.filter((m) => m.timestamp < beforeTs);
    return older.slice(0, 40);
  }
  async memberNames() { return {}; }
  async presence() { return { status: "online" as const, lastSeenRelative: null }; }
  async sendText() { await this.sendGate; return this.sendResult; }
  async sendFile() { return { ok: true as const, messageId: "srv-f" }; }
  async markRead(jid: string) { this.marked.push(jid); }
  async waitForMessages() { return new Promise<{ cursor: number; events: IncomingEvent[] }>(() => undefined); }
  async currentCursor() { return 0; }
  async openMedia() { return "ok"; }
  fileExists() { return true; }
  searchHits: Record<string, { id: string; chatJid: string; ts: number; fromMe: boolean; senderJid: string | null; snippet: string }[]> = {};
  async search(jid: string) { return this.searchHits[jid] ?? []; }
  async stickerMoods() { return ["risa", "ok"]; }
  stickerList: { id: string; description: string | null }[] = [];
  async stickers() { return this.stickerList; }
  sentStickers: string[] = [];
  async sendSticker(_j: string, id: string) { this.sentStickers.push(id); return { ok: true as const, messageId: "st" }; }
  voiceSeconds = 75;
  async sendVoice() { return { ok: true as const, messageId: "v", seconds: this.voiceSeconds }; }
  pages: Record<string, RawMessage[][]> = {};
}

const overview = (jid: string, ts: number, over: Partial<OverviewRow> = {}): OverviewRow => ({
  jid, is_group: 0, unread_count: 0, last_message_ts: ts, display_name: jid.split("@")[0]!, alt_jid: null,
  last_text: "hola", last_from_me: 0, last_type: "text", last_sender_name: null, ...over,
});
const raw = (chat: string, id: string, ts: number, text = "hola"): RawMessage => ({ id, chat_jid: chat, sender_jid: chat, from_me: 0, timestamp: ts, text, message_type: "text" });
const tick = () => new Promise((r) => setTimeout(r, 5));

async function started(gw: FakeGateway) {
  const c = new UltraController(gw);
  await c.start();
  return c;
}

describe("UltraController", () => {
  it("shows a QR when the session is gone and continues by itself once scanned", async () => {
    const gw = new FakeGateway();
    gw.state = "logged_out";
    gw.qrs = ["QR-1"];
    const c = new UltraController(gw);
    const seen: (string | null)[] = [];
    c.subscribe(() => seen.push(c.getState().link.qr));
    await c.start();
    expect(seen).toContain("QR-1");
    expect(c.getState().link.phase).toBe("ready");
    c.stop();
  });

  it("lists chats newest first and clears the badge of the chat you open", async () => {
    const gw = new FakeGateway();
    gw.rows = [overview("b@s.whatsapp.net", 1, { unread_count: 4 }), overview("a@s.whatsapp.net", 9)];
    const c = await started(gw);
    expect(c.getState().chats.map((x) => x.jid)).toEqual(["a@s.whatsapp.net", "b@s.whatsapp.net"]);
    await c.openChat("b@s.whatsapp.net");
    expect(c.getState().chats.find((x) => x.jid === "b@s.whatsapp.net")!.unread).toBe(0);
    expect(c.getState().conversations["b@s.whatsapp.net"]!.unreadAtOpen).toBe(4);
    c.stop();
  });

  it("a slow chat load never paints over the chat you switched to", async () => {
    const gw = new FakeGateway();
    gw.rows = [overview("slow@s.whatsapp.net", 2), overview("fast@s.whatsapp.net", 1)];
    gw.history = { "slow@s.whatsapp.net": [raw("slow@s.whatsapp.net", "s1", 1)], "fast@s.whatsapp.net": [raw("fast@s.whatsapp.net", "f1", 1)] };
    gw.delays = { "slow@s.whatsapp.net": 40 };
    const c = await started(gw);
    const slow = c.openChat("slow@s.whatsapp.net");
    await c.openChat("fast@s.whatsapp.net");
    await slow;
    expect(c.getState().openJid).toBe("fast@s.whatsapp.net");
    expect(c.getState().conversations["slow@s.whatsapp.net"]?.messages ?? []).toHaveLength(0);
    c.stop();
  });

  it("reads BOTH halves of an @lid/phone pair as one conversation", async () => {
    const gw = new FakeGateway();
    gw.rows = [overview("1@lid", 5, { alt_jid: "51@s.whatsapp.net" }), overview("51@s.whatsapp.net", 3, { alt_jid: "1@lid" })];
    gw.history = { "1@lid": [raw("1@lid", "new", 5)], "51@s.whatsapp.net": [raw("51@s.whatsapp.net", "old", 3)] };
    const c = await started(gw);
    expect(c.getState().chats).toHaveLength(1);
    await c.openChat("1@lid");
    expect(c.getState().conversations["1@lid"]!.messages.map((m) => m.id)).toEqual(["old", "new"]);
    c.stop();
  });

  it("sends optimistically: bubble shows at once as pending, then ticks with the server id", async () => {
    const gw = new FakeGateway();
    gw.rows = [overview("b@s.whatsapp.net", 1), overview("a@s.whatsapp.net", 9)];
    let release!: () => void;
    gw.sendGate = new Promise((r) => (release = r));
    const c = await started(gw);
    await c.openChat("b@s.whatsapp.net");
    const p = c.sendText("  hola!  ");
    const pending = c.getState().conversations["b@s.whatsapp.net"]!.messages.at(-1)!;
    expect(pending).toMatchObject({ text: "hola!", status: "pending", fromMe: true });
    expect(c.getState().chats[0]!.jid).toBe("b@s.whatsapp.net"); // bumped to the top immediately
    release();
    await p;
    expect(c.getState().conversations["b@s.whatsapp.net"]!.messages.at(-1)).toMatchObject({ id: "srv-1", status: "sent" });
    c.stop();
  });

  it("a failed send stays visible with its reason and can be retried in place", async () => {
    const gw = new FakeGateway();
    gw.rows = [overview("a@s.whatsapp.net", 1)];
    gw.sendResult = { ok: false, reason: "sin conexión" };
    const c = await started(gw);
    await c.openChat("a@s.whatsapp.net");
    await c.sendText("hola");
    const failed = c.lastFailed()!;
    expect(failed).toMatchObject({ status: "failed", error: "sin conexión" });
    expect(c.getState().notice?.tone).toBe("error");
    gw.sendResult = { ok: true, messageId: "srv-2" };
    await c.retry(failed.id);
    expect(c.lastFailed()).toBeNull();
    c.stop();
  });

  it("incoming: appends to the open chat (and marks read), banners for others", async () => {
    const gw = new FakeGateway();
    gw.rows = [overview("a@s.whatsapp.net", 2), overview("b@s.whatsapp.net", 1)];
    const c = await started(gw);
    await c.openChat("a@s.whatsapp.net");
    c.ingest({ id: "in1", chat: "a@s.whatsapp.net", chatName: "a", from: "a@s.whatsapp.net", at: new Date().toISOString(), text: "¿vienes?", type: "text" });
    expect(c.getState().conversations["a@s.whatsapp.net"]!.messages.at(-1)).toMatchObject({ id: "in1", status: "received" });
    await tick();
    expect(gw.marked).toContain("a@s.whatsapp.net");
    c.ingest({ id: "in2", chat: "b@s.whatsapp.net", chatName: "b", from: "b@s.whatsapp.net", at: new Date().toISOString(), text: "oye", type: "text" });
    expect(c.getState().banner).toMatchObject({ chatJid: "b@s.whatsapp.net", text: "oye" });
    c.stop();
  });

  it("search covers both halves of an @lid/phone pair, newest first", async () => {
    const gw = new FakeGateway();
    gw.rows = [overview("1@lid", 5, { alt_jid: "51@s.whatsapp.net" }), overview("51@s.whatsapp.net", 3, { alt_jid: "1@lid" })];
    gw.searchHits = {
      "1@lid": [{ id: "n", chatJid: "1@lid", ts: 9, fromMe: false, senderJid: null, snippet: "viaje nuevo" }],
      "51@s.whatsapp.net": [{ id: "o", chatJid: "51@s.whatsapp.net", ts: 2, fromMe: true, senderJid: null, snippet: "viaje viejo" }],
    };
    const c = await started(gw);
    await c.openChat("1@lid");
    expect((await c.searchConversation("viaje")).map((h) => h.id)).toEqual(["n", "o"]);
    expect(await c.searchConversation("v")).toEqual([]); // too short to be useful
    c.stop();
  });

  it("jumping to an old hit pages back until it is loaded", async () => {
    const gw = new FakeGateway();
    gw.rows = [overview("a@s.whatsapp.net", 1000)];
    // 120 messages: the first page (40) does not contain the target at ts=5.
    gw.history = { "a@s.whatsapp.net": Array.from({ length: 120 }, (_, i) => raw("a@s.whatsapp.net", `m${i}`, i)) };
    const c = await started(gw);
    await c.openChat("a@s.whatsapp.net");
    expect(c.getState().conversations["a@s.whatsapp.net"]!.messages.some((m) => m.id === "m5")).toBe(false);
    expect(await c.jumpTo("m5", 5)).toBe(true);
    expect(c.getState().conversations["a@s.whatsapp.net"]!.messages.some((m) => m.id === "m5")).toBe(true);
    c.stop();
  });

  it("stickers: says so when a mood has none; sends the ranked best otherwise", async () => {
    const gw = new FakeGateway();
    gw.rows = [overview("a@s.whatsapp.net", 1)];
    const c = await started(gw);
    await c.openChat("a@s.whatsapp.net");
    await c.sendSticker("risa");
    expect(c.getState().notice?.text).toMatch(/No tienes stickers/);
    gw.stickerList = [{ id: "own:1", description: "gato riendo" }];
    await c.sendSticker("risa");
    expect(gw.sentStickers).toEqual(["own:1"]);
    expect(c.getState().conversations["a@s.whatsapp.net"]!.messages.at(-1)).toMatchObject({ kind: "sticker", status: "sent" });
    c.stop();
  });

  it("voice notes show their real duration as m:ss once sent", async () => {
    const gw = new FakeGateway();
    gw.rows = [overview("a@s.whatsapp.net", 1)];
    const c = await started(gw);
    await c.openChat("a@s.whatsapp.net");
    await c.sendVoice("hola, ya llegué");
    expect(c.getState().conversations["a@s.whatsapp.net"]!.messages.at(-1)).toMatchObject({ kind: "voice", text: "1:15", status: "sent" });
    c.stop();
  });

  it("never throws to the UI: a broken daemon becomes a notice", async () => {
    const gw = new FakeGateway();
    gw.rows = [overview("a@s.whatsapp.net", 1)];
    const c = await started(gw);
    gw.messages = async () => { throw new Error("daemon caído"); };
    // fetchMessages swallows per-identity errors; an overview failure must too.
    gw.overview = async () => { throw new Error("daemon caído"); };
    await expect(c.refreshChats()).resolves.toBeUndefined();
    expect(c.getState().notice?.text).toMatch(/daemon caído/);
    c.stop();
  });
});
