import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DaemonClient } from "../../daemon/client.js";
import { openWithSystemViewer } from "../../cli/chat-core.js";
import type { MessageKind } from "../domain/message.js";
import { profileNotes, styleSentence, type Commitment } from "../domain/contact.js";
import type { AgendaGateway, ContactInfoPort, ChatGateway, LinkState, Presence, SearchHit, SendOutcome, StickerOption } from "../application/ports.js";

/**
 * Adapter: the app's ChatGateway port implemented over the Wacon daemon's
 * RPC client. Translation only — daemon shapes in, app shapes out — so the
 * controller never sees `Guided`, `SendResult` or base64 payloads.
 */
export class DaemonGateway implements ChatGateway, AgendaGateway, ContactInfoPort {
  private static readonly CLIENT = "cli-ultra";

  constructor(private readonly client: DaemonClient) {}

  // ── what Wacon knows ──
  async contactInfo(chatJid: string) {
    const b = await this.client.getProfile(chatJid);
    return {
      facts: b.facts.map((f) => ({ category: f.category, fact: f.fact })),
      tags: b.tags,
      notes: profileNotes(b.profile?.body),
      style: styleSentence(b.profile?.stats as Record<string, unknown> | null | undefined),
    };
  }
  async commitments(): Promise<Commitment[]> {
    const rows = (await this.client.commitments(21)) as { chat: string; name: string | null; text: string; ageDays: number }[];
    return rows.map((c) => ({ chatJid: c.chat, name: c.name, text: c.text, ageDays: c.ageDays }));
  }

  // ── Agenda ──
  async agenda(withinDays: number) {
    const [events, tasks, staleSuggestions, commitments] = await Promise.all([this.client.listEvents({ withinDays }), this.client.listTasks(false), this.client.staleSuggestionCount(), this.commitments().catch(() => [])]);
    return {
      events: events.map((e) => ({ id: e.id, title: e.title, startTs: e.start_ts, chatJid: e.chat_jid, status: e.status, notes: e.notes })),
      tasks: tasks.map((t) => ({ id: t.id, title: t.title, dueTs: t.due_ts, chatJid: t.chat_jid, notes: t.notes })),
      staleSuggestions,
      commitments,
    };
  }
  async scheduleEvent(input: { title: string; start: string; chat?: string; notes?: string }) {
    await this.client.scheduleEvent({ ...input, notifyBeforeMinutes: 60 });
  }
  async addTask(input: { title: string; due?: string; chat?: string; notes?: string }) {
    await this.client.addTask(input);
  }
  async completeEvent(id: number) {
    await this.client.completeEvent(id);
  }
  async cancelEvent(id: number) {
    await this.client.cancelEvent(id);
  }
  async completeTask(id: number) {
    await this.client.completeTask(id);
  }
  async dismissStaleSuggestions() {
    return (await this.client.dismissStaleSuggestions()).dismissed;
  }

  async linkState() {
    const s = await this.client.status();
    return {
      state: s.state as LinkState,
      selfName: null,
      selfJids: [s.selfJid, s.selfLid].filter((j): j is string => !!j),
      health: { authError: s.authError ?? null, freeDiskBytes: s.freeDiskBytes ?? null },
    };
  }
  async relink() {
    return (await this.client.relogin()).state as LinkState;
  }
  async qr() {
    const r = await this.client.qr();
    return { state: r.state as LinkState, qr: r.qr };
  }

  overview(limit: number) {
    return this.client.chatOverview(limit);
  }
  messages(chatJid: string, limit: number, beforeTs?: number) {
    return this.client.readMessages(chatJid, limit, beforeTs);
  }
  async memberNames(groupJid: string) {
    const rows = (await this.client.groupMembers(groupJid, 1)) as { sender_jid: string; display_name: string | null }[];
    const out: Record<string, string> = {};
    for (const r of rows) if (r.display_name) out[r.sender_jid] = r.display_name;
    return out;
  }
  async presence(chatJid: string): Promise<Presence> {
    const p = await this.client.contactPresence(chatJid, 2);
    return { status: p.status, lastSeenRelative: p.lastSeenRelative };
  }

  async reactions(chatJid: string, messageIds: string[]) {
    const rows = await this.client.messageReactions(chatJid, messageIds);
    return rows.map((r) => ({ targetId: r.target_id, senderJid: r.sender_jid, fromMe: r.from_me === 1, emoji: r.emoji }));
  }
  async react(chatJid: string, messageId: string, emoji: string): Promise<SendOutcome> {
    const r = await this.client.react(chatJid, messageId, emoji, DaemonGateway.CLIENT);
    return r.sent ? { ok: true, messageId: r.messageId } : { ok: false, reason: r.reason ?? "bloqueado" };
  }
  messageStatuses(ids: string[]) {
    return this.client.messageStatuses(ids);
  }
  messagesByIds(chatJid: string, ids: string[]) {
    return this.client.messagesByIds(chatJid, ids);
  }
  async sendText(chatJid: string, text: string, replyTo?: string): Promise<SendOutcome> {
    const r = await this.client.send(chatJid, text, DaemonGateway.CLIENT, 0, replyTo);
    return r.sent ? { ok: true, messageId: r.messageId } : { ok: false, reason: r.reason ?? (r.dryRun ? "modo prueba (dryRun)" : "bloqueado") };
  }
  async sendFile(chatJid: string, path: string, caption?: string) {
    const r = await this.client.sendFile(chatJid, path, { clientName: DaemonGateway.CLIENT, caption });
    if ("guidance" in r) return { ok: false as const, reason: r.guidance };
    if (!r.sent) return { ok: false as const, reason: r.reason ?? "bloqueado" };
    return { ok: true as const, messageId: r.messageId, kind: r.kind as MessageKind | undefined, fileName: r.fileName };
  }
  async markRead(chatJid: string) {
    await this.client.markRead(chatJid, 10);
  }

  async search(chatJid: string, query: string, limit: number): Promise<SearchHit[]> {
    const hits = await this.client.searchMessages(query, chatJid, limit);
    return hits.map((h) => ({ id: h.id, chatJid: h.chat_jid, ts: h.timestamp, fromMe: h.from_me === 1, senderJid: h.sender_jid, snippet: h.snippet }));
  }
  async stickerMoods(): Promise<string[]> {
    const r = (await this.client.listStickers({ limit: 1 })) as { moods?: string[] };
    return r.moods ?? [];
  }
  async stickers(chatJid: string, mood: string, limit: number): Promise<StickerOption[]> {
    const r = (await this.client.listStickers({ mood, chat: chatJid, limit })) as { stickers?: { id: string; description?: string | null }[] };
    return (r.stickers ?? []).map((s) => ({ id: s.id, description: s.description ?? null }));
  }
  async sendSticker(chatJid: string, stickerId: string): Promise<SendOutcome> {
    const r = await this.client.sendSticker(chatJid, stickerId, DaemonGateway.CLIENT);
    if ("guidance" in r) return { ok: false, reason: r.guidance };
    return r.sent ? { ok: true, messageId: r.messageId } : { ok: false, reason: r.reason ?? "bloqueado" };
  }
  async sendVoice(chatJid: string, text: string) {
    const r = await this.client.sendVoice(chatJid, text, { clientName: DaemonGateway.CLIENT });
    if ("guidance" in r) return { ok: false as const, reason: r.guidance };
    if (!r.sent) return { ok: false as const, reason: r.reason ?? "bloqueado" };
    return { ok: true as const, messageId: r.messageId, seconds: r.seconds };
  }

  async waitForMessages(cursor: number, timeoutSeconds: number) {
    const r = await this.client.waitForMessages({ since: cursor, timeoutSeconds });
    return { cursor: r.cursor, events: r.events };
  }
  async currentCursor() {
    return (await this.client.status()).cursor;
  }

  async fetchMedia(chatJid: string, messageId: string) {
    const res = await this.client.viewImage(chatJid, messageId);
    if ("guidance" in res) throw new Error(res.guidance);
    return { data: new Uint8Array(Buffer.from(res.base64, "base64")), mimetype: res.mimetype };
  }

  /**
   * Terminals cannot show images reliably, so the file is saved and handed to
   * the OS viewer — what the user would do anyway. Voice notes come back as
   * a transcript when a transcription backend is configured.
   */
  async openMedia(chatJid: string, messageId: string, kind: MessageKind): Promise<string> {
    const dir = join(tmpdir(), "wacon-media");
    mkdirSync(dir, { recursive: true });
    if (kind === "voice" || kind === "audio") {
      const res = await this.client.transcribeAudio(chatJid, messageId);
      if ("guidance" in res) throw new Error(res.guidance);
      if (res.mode === "transcript") return `🎧 “${res.text}”`;
      const file = join(dir, `${messageId}.ogg`);
      writeFileSync(file, Buffer.from(res.base64, "base64"));
      openWithSystemViewer(file);
      return "Reproduciendo el audio en tu reproductor";
    }
    const res = await this.client.viewImage(chatJid, messageId);
    if ("guidance" in res) throw new Error(res.guidance);
    const ext = (res.mimetype.split("/")[1] ?? "bin").replace(/[^a-z0-9]/gi, "") || "bin";
    const file = join(dir, `${messageId}.${ext}`);
    writeFileSync(file, Buffer.from(res.base64, "base64"));
    openWithSystemViewer(file);
    return res.description ? `Abierto en tu visor · ${res.description}` : "Abierto en tu visor de imágenes";
  }

  fileExists(path: string): boolean {
    try {
      return existsSync(path) && statSync(path).isFile();
    } catch {
      return false;
    }
  }
}
