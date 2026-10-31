import { byRecency, foldIdentities, matchesQuery, toSummary, type ChatSummary } from "../domain/chat.js";
import { cleanText, kindOf, mergeMessages, type ChatMessage, type MessageKind } from "../domain/message.js";
import { fileNameOf } from "../domain/input.js";
import { shouldNotify } from "../domain/notify.js";
import { isInvisibleMessage } from "../../core/message-types.js";
import type { ChatGateway, IncomingEvent, LinkState, Presence, RawMessage } from "./ports.js";

/**
 * The app's use cases and its single source of state. Presentation reads the
 * state (subscribe/getState fit React's useSyncExternalStore) and calls the
 * methods; it never talks to the gateway itself.
 *
 * Every public method is a UI boundary: it never throws. Failures become a
 * `notice`, so a daemon hiccup can no longer take the whole terminal down.
 */

export interface ConversationState {
  messages: ChatMessage[];
  loading: boolean;
  loadingOlder: boolean;
  hasMore: boolean;
  /** Unread count when the chat was opened — drives the "N no leídos" marker. */
  unreadAtOpen: number;
  memberNames: Record<string, string>;
  presence: Presence | null;
}

export interface Banner {
  chatJid: string;
  title: string;
  text: string;
  at: number;
}

export interface Notice {
  text: string;
  tone: "info" | "success" | "error";
  at: number;
}

export interface UltraState {
  link: { phase: "checking" | "linking" | "ready" | "error"; state: LinkState | null; qr: string | null; error: string | null };
  selfName: string | null;
  chats: ChatSummary[];
  chatsLoaded: boolean;
  openJid: string | null;
  conversations: Record<string, ConversationState>;
  drafts: Record<string, string>;
  banner: Banner | null;
  /** Label of the slow operation in flight ("enviando foto.jpg"), for the spinner. */
  busy: string | null;
  notice: Notice | null;
}

const PAGE = 40;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class UltraController {
  private state: UltraState = {
    link: { phase: "checking", state: null, qr: null, error: null },
    selfName: null,
    chats: [],
    chatsLoaded: false,
    openJid: null,
    conversations: {},
    drafts: {},
    banner: null,
    busy: null,
    notice: null,
  };
  private listeners = new Set<() => void>();
  private running = false;
  private cursor = 0;
  private openSeq = 0;
  private localSeq = 0;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastNotified = new Map<string, number>();

  constructor(
    private readonly gw: ChatGateway,
    private readonly now: () => number = Date.now
  ) {}

  // ── store plumbing ───────────────────────────────────────
  getState = (): UltraState => this.state;
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  private set(patch: Partial<UltraState> | ((s: UltraState) => Partial<UltraState>)): void {
    const p = typeof patch === "function" ? patch(this.state) : patch;
    this.state = { ...this.state, ...p };
    for (const l of this.listeners) l();
  }
  private patchConvo(jid: string, p: Partial<ConversationState>): void {
    this.set((s) => {
      const prev = s.conversations[jid] ?? emptyConvo();
      return { conversations: { ...s.conversations, [jid]: { ...prev, ...p } } };
    });
  }
  private notify(text: string, tone: Notice["tone"] = "info"): void {
    this.set({ notice: { text, tone, at: this.now() } });
  }
  private async busy<T>(label: string, fn: () => Promise<T>): Promise<T> {
    this.set({ busy: label });
    try {
      return await fn();
    } finally {
      if (this.state.busy === label) this.set({ busy: null });
    }
  }

  /** Selectors that several components need. */
  currentChat(): ChatSummary | null {
    return this.state.chats.find((c) => c.jid === this.state.openJid) ?? null;
  }
  findChat(jid: string): ChatSummary | null {
    return this.state.chats.find((c) => c.jid === jid || c.aliases.includes(jid)) ?? null;
  }

  // ── lifecycle ────────────────────────────────────────────
  async start(initialQuery?: string): Promise<void> {
    this.running = true;
    const linked = await this.ensureLinked();
    if (!linked) return;
    await this.refreshChats();
    this.cursor = await this.gw.currentCursor().catch(() => 0);
    void this.feed();
    // The live feed only carries INCOMING messages; this catches what you
    // send from the phone and the trickle of a fresh history sync.
    this.pollTimer = setInterval(() => this.scheduleRefresh(0), 20_000);
    this.pollTimer.unref?.();
    if (initialQuery) {
      const hit = this.state.chats.find((c) => matchesQuery(c, initialQuery));
      if (hit) await this.openChat(hit.jid);
      else this.notify(`No encontré un chat para "${initialQuery}"`, "error");
    }
  }

  stop(): void {
    this.running = false;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  /**
   * Make sure there is a live WhatsApp session, showing a QR when there is
   * not. Returns false only when stopped before linking finished.
   */
  async ensureLinked(): Promise<boolean> {
    try {
      const { state, selfName } = await this.gw.linkState();
      this.set({ selfName });
      if (state === "connected") {
        this.set({ link: { phase: "ready", state, qr: null, error: null } });
        return true;
      }
      // Transient reconnects resolve themselves; only a dead session needs a QR.
      if (state === "connecting" || state === "disconnected") {
        this.set({ link: { phase: "checking", state, qr: null, error: null } });
        for (let i = 0; i < 20 && this.running; i++) {
          await sleep(500);
          const r = await this.gw.linkState();
          if (r.state === "connected") {
            this.set({ link: { phase: "ready", state: r.state, qr: null, error: null }, selfName: r.selfName });
            return true;
          }
          if (r.state === "waiting_qr" || r.state === "logged_out") break;
        }
      }
      this.set({ link: { phase: "linking", state, qr: null, error: null } });
      await this.gw.relink();
      while (this.running) {
        const r = await this.gw.qr();
        if (r.state === "connected") {
          const who = await this.gw.linkState().catch(() => ({ selfName: null }));
          this.set({ link: { phase: "ready", state: r.state, qr: null, error: null }, selfName: who.selfName });
          this.notify("WhatsApp vinculado · el historial se sincroniza en segundo plano", "success");
          return true;
        }
        if (r.qr !== this.state.link.qr) this.set({ link: { phase: "linking", state: r.state, qr: r.qr, error: null } });
        await sleep(1500);
      }
      return false;
    } catch (e) {
      this.set({ link: { phase: "error", state: null, qr: null, error: errText(e) } });
      return false;
    }
  }

  // ── chat list ────────────────────────────────────────────
  async refreshChats(): Promise<void> {
    try {
      const rows = await this.gw.overview(200);
      const chats = foldIdentities(rows.map(toSummary)).sort(byRecency);
      // The chat being read never shows a badge.
      const open = this.state.openJid;
      for (const c of chats) if (c.jid === open || (open && c.aliases.includes(open))) c.unread = 0;
      this.set({ chats, chatsLoaded: true });
    } catch (e) {
      this.set({ chatsLoaded: true });
      this.notify(`No pude cargar los chats: ${errText(e)}`, "error");
    }
  }

  /** One refresh per burst of events instead of one per message. */
  scheduleRefresh(delayMs = 350): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshChats();
    }, delayMs);
  }

  // ── conversation ─────────────────────────────────────────
  async openChat(jid: string): Promise<void> {
    const chat = this.findChat(jid);
    if (!chat) return;
    const seq = ++this.openSeq;
    const cached = this.state.conversations[chat.jid];
    this.set({ openJid: chat.jid, banner: this.state.banner?.chatJid === chat.jid ? null : this.state.banner });
    this.patchConvo(chat.jid, { loading: !cached, unreadAtOpen: chat.unread });
    // Clear the badge immediately — the user is looking at it now.
    this.set((s) => ({ chats: s.chats.map((c) => (c.jid === chat.jid ? { ...c, unread: 0 } : c)) }));

    try {
      const [msgs, names] = await Promise.all([
        this.fetchMessages(chat, PAGE),
        chat.isGroup ? this.gw.memberNames(chat.jid).catch(() => ({})) : Promise.resolve({}),
      ]);
      if (seq !== this.openSeq) return; // user already moved on
      const local = (this.state.conversations[chat.jid]?.messages ?? []).filter((m) => m.status === "pending" || m.status === "failed");
      this.patchConvo(chat.jid, {
        messages: mergeMessages(msgs, local),
        loading: false,
        hasMore: msgs.length >= PAGE,
        memberNames: names,
      });
    } catch (e) {
      if (seq === this.openSeq) this.patchConvo(chat.jid, { loading: false });
      this.notify(`No pude abrir el chat: ${errText(e)}`, "error");
      return;
    }
    void this.gw.markRead(chat.jid).catch(() => undefined);
    if (!chat.isGroup) void this.refreshPresence(chat.jid);
  }

  closeChat(): void {
    this.openSeq++;
    this.set({ openJid: null });
  }

  /** Both halves of an @lid/phone pair hold messages of the same conversation. */
  private async fetchMessages(chat: ChatSummary, limit: number, beforeTs?: number): Promise<ChatMessage[]> {
    const lists = await Promise.all([chat.jid, ...chat.aliases].map((j) => this.gw.messages(j, limit, beforeTs).catch(() => [] as RawMessage[])));
    // Reactions, edits, poll votes… are machinery, not bubbles.
    const visible = lists.flat().filter((r) => !isInvisibleMessage(r.message_type, r.text));
    return mergeMessages([], visible.map((r) => fromRaw(r, chat.jid)));
  }

  async loadOlder(): Promise<void> {
    const chat = this.currentChat();
    const convo = chat ? this.state.conversations[chat.jid] : undefined;
    if (!chat || !convo || convo.loadingOlder || !convo.hasMore || convo.messages.length === 0) return;
    this.patchConvo(chat.jid, { loadingOlder: true });
    try {
      const older = await this.fetchMessages(chat, PAGE, convo.messages[0]!.ts);
      const current = this.state.conversations[chat.jid]?.messages ?? [];
      this.patchConvo(chat.jid, { messages: mergeMessages(current, older), loadingOlder: false, hasMore: older.length >= PAGE });
    } catch (e) {
      this.patchConvo(chat.jid, { loadingOlder: false });
      this.notify(`No pude cargar mensajes anteriores: ${errText(e)}`, "error");
    }
  }

  async refreshPresence(jid: string): Promise<void> {
    try {
      const p = await this.gw.presence(jid);
      if (this.state.openJid === jid) this.patchConvo(jid, { presence: p });
    } catch {
      // presence is decoration — never worth an error message
    }
  }

  setDraft(jid: string, text: string): void {
    this.set((s) => ({ drafts: { ...s.drafts, [jid]: text } }));
  }

  // ── sending ──────────────────────────────────────────────
  /**
   * Optimistic: the bubble appears instantly with a clock, then turns into a
   * tick or an error. Waiting for the network before drawing anything is the
   * single biggest reason a chat UI feels sluggish.
   */
  async sendText(text: string): Promise<void> {
    const chat = this.currentChat();
    const body = text.trim();
    if (!chat || !body) return;
    const local = this.addLocal(chat.jid, { text: body, kind: "text" });
    this.setDraft(chat.jid, "");
    this.bump(chat.jid, { text: body, kind: "text" });
    const r = await this.gw.sendText(chat.jid, body).catch((e: unknown) => ({ ok: false as const, reason: errText(e) }));
    this.settle(chat.jid, local.id, r);
  }

  async sendFile(path: string, caption?: string): Promise<void> {
    const chat = this.currentChat();
    if (!chat) return;
    if (!this.gw.fileExists(path)) {
      this.notify(`No existe el archivo: ${path}`, "error");
      return;
    }
    const name = fileNameOf(path);
    const kind = guessKind(name);
    const local = this.addLocal(chat.jid, { text: caption ? `${name} — ${caption}` : name, kind });
    this.bump(chat.jid, { text: name, kind });
    const r = await this.busy(`enviando ${name}`, () =>
      this.gw.sendFile(chat.jid, path, caption).catch((e: unknown) => ({ ok: false as const, reason: errText(e) }))
    );
    this.settle(chat.jid, local.id, r);
  }

  /** Re-send a failed message in place. */
  async retry(localId: string): Promise<void> {
    const jid = this.state.openJid;
    const m = jid ? this.state.conversations[jid]?.messages.find((x) => x.id === localId) : undefined;
    if (!jid || !m || m.status !== "failed" || m.kind !== "text") return;
    this.updateMessage(jid, localId, { status: "pending", error: undefined });
    const r = await this.gw.sendText(jid, m.text).catch((e: unknown) => ({ ok: false as const, reason: errText(e) }));
    this.settle(jid, localId, r);
  }

  lastFailed(): ChatMessage | null {
    const jid = this.state.openJid;
    const msgs = jid ? (this.state.conversations[jid]?.messages ?? []) : [];
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]!.status === "failed") return msgs[i]!;
    return null;
  }

  private addLocal(jid: string, p: { text: string; kind: MessageKind }): ChatMessage {
    const m: ChatMessage = { id: `local-${++this.localSeq}`, chatJid: jid, senderJid: null, fromMe: true, ts: this.now(), text: p.text, kind: p.kind, status: "pending" };
    const convo = this.state.conversations[jid] ?? emptyConvo();
    this.patchConvo(jid, { messages: [...convo.messages, m] });
    return m;
  }

  private settle(jid: string, localId: string, r: { ok: true; messageId: string | null } | { ok: false; reason: string }): void {
    if (r.ok) {
      // Adopt the server id so the copy the daemon stores is not shown twice.
      this.updateMessage(jid, localId, { status: "sent", ...(r.messageId ? { id: r.messageId } : {}) });
    } else {
      this.updateMessage(jid, localId, { status: "failed", error: r.reason });
      this.notify(`No se envió: ${r.reason} · Ctrl+R reintenta`, "error");
    }
  }

  private updateMessage(jid: string, id: string, p: Partial<ChatMessage>): void {
    const convo = this.state.conversations[jid];
    if (!convo) return;
    this.patchConvo(jid, { messages: convo.messages.map((m) => (m.id === id ? { ...m, ...p } : m)) });
  }

  /** A send moves its chat to the top at once, exactly like on the phone. */
  private bump(jid: string, p: { text: string; kind: MessageKind }): void {
    this.set((s) => {
      const row = s.chats.find((c) => c.jid === jid);
      if (!row) return {};
      const updated: ChatSummary = { ...row, lastTs: this.now(), preview: { text: p.text, fromMe: true, senderName: null, kind: p.kind } };
      return { chats: [updated, ...s.chats.filter((c) => c.jid !== jid)] };
    });
  }

  // ── media ────────────────────────────────────────────────
  async openMedia(messageId: string): Promise<void> {
    const jid = this.state.openJid;
    const m = jid ? this.state.conversations[jid]?.messages.find((x) => x.id === messageId) : undefined;
    if (!jid || !m) return;
    try {
      const note = await this.busy(m.kind === "voice" || m.kind === "audio" ? "descargando audio" : "descargando archivo", () =>
        this.gw.openMedia(m.chatJid, m.id, m.kind)
      );
      this.notify(note, "info");
    } catch (e) {
      this.notify(`No pude abrir el archivo: ${errText(e)}`, "error");
    }
  }

  // ── notifications ────────────────────────────────────────
  /** Status-bar message from the UI itself ("Pulsa Ctrl+C otra vez…"). */
  inform(text: string, tone: Notice["tone"] = "info"): void {
    this.notify(text, tone);
  }
  dismissBanner(): void {
    if (this.state.banner) this.set({ banner: null });
  }
  clearNotice(): void {
    if (this.state.notice) this.set({ notice: null });
  }

  // ── live feed ────────────────────────────────────────────
  private async feed(): Promise<void> {
    while (this.running) {
      try {
        const r = await this.gw.waitForMessages(this.cursor, 50);
        this.cursor = r.cursor;
        for (const e of r.events) this.ingest(e);
        if (r.events.length > 0) this.scheduleRefresh();
      } catch {
        if (this.running) await sleep(2000);
      }
    }
  }

  /** Exposed for tests; the feed loop calls it for every incoming message. */
  ingest(e: IncomingEvent): void {
    if (isInvisibleMessage(e.type, e.text)) return;
    const open = this.currentChat();
    const isOpen = !!open && (e.chat === open.jid || open.aliases.includes(e.chat));
    const kind = kindOf(e.type, e.text);
    if (isOpen) {
      const msg: ChatMessage = {
        id: e.id,
        chatJid: e.chat,
        senderJid: e.from,
        fromMe: false,
        ts: new Date(e.at).getTime(),
        text: cleanText(e.text, kind),
        kind,
        status: "received",
        arrivedAt: this.now(),
      };
      const convo = this.state.conversations[open.jid] ?? emptyConvo();
      this.patchConvo(open.jid, { messages: mergeMessages(convo.messages, [msg]), presence: convo.presence?.status === "typing" ? { ...convo.presence, status: "online" } : convo.presence });
      void this.gw.markRead(e.chat).catch(() => undefined);
      return;
    }
    const chat = this.findChat(e.chat);
    const now = this.now();
    const ok = shouldNotify({
      isGroup: chat?.isGroup ?? e.chat.endsWith("@g.us"),
      text: e.text ?? "",
      selfName: this.state.selfName,
      lastNotifiedAt: this.lastNotified.get(e.chat) ?? 0,
      now,
    });
    if (!ok) return;
    this.lastNotified.set(e.chat, now);
    this.set({
      banner: {
        chatJid: chat?.jid ?? e.chat,
        title: chat?.name ?? e.chatName ?? "Nuevo mensaje",
        text: cleanText(e.text, kind) || "(archivo)",
        at: now,
      },
    });
  }
}

function emptyConvo(): ConversationState {
  return { messages: [], loading: false, loadingOlder: false, hasMore: true, unreadAtOpen: 0, memberNames: {}, presence: null };
}

function fromRaw(r: RawMessage, _chat: string): ChatMessage {
  const kind = kindOf(r.message_type, r.text);
  return {
    id: r.id,
    chatJid: r.chat_jid,
    senderJid: r.sender_jid,
    fromMe: r.from_me === 1,
    ts: r.timestamp,
    text: cleanText(r.text, kind),
    kind,
    status: r.from_me === 1 ? "sent" : "received",
  };
}

function guessKind(fileName: string): MessageKind {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  if (["jpg", "jpeg", "png", "gif", "webp", "heic"].includes(ext)) return "image";
  if (["mp4", "mov", "mkv", "webm", "3gp"].includes(ext)) return "video";
  if (["mp3", "ogg", "opus", "m4a", "wav", "aac"].includes(ext)) return "audio";
  return "document";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
