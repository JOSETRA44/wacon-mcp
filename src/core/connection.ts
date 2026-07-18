import makeWASocket, {
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
  getContentType,
  jidNormalizedUser,
  downloadMediaMessage,
  type WASocket,
  type WAMessage,
  type GroupMetadata,
  type WAPresence,
} from "@whiskeysockets/baileys";
import { EventEmitter } from "node:events";
import { rmSync } from "node:fs";
import pino from "pino";
import { AUTH_DIR, ensureDirs } from "./paths.js";
import type { Store, MessageRow, MediaRow } from "./store.js";

const MEDIA_KINDS = ["image", "audio", "video", "document", "sticker"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/** Pull the downloadable stub + a human placeholder from a media message. */
function extractMedia(msg: WAMessage): { stub: Omit<MediaRow, "chat_jid" | "msg_id" | "timestamp"> | null; placeholder: string | null } {
  const c = msg.message;
  if (!c) return { stub: null, placeholder: null };
  const node = c.imageMessage ?? c.audioMessage ?? c.videoMessage ?? c.documentMessage ?? c.stickerMessage;
  if (!node) return { stub: null, placeholder: null };
  const kind: MediaKind = c.imageMessage
    ? "image"
    : c.audioMessage
      ? "audio"
      : c.videoMessage
        ? "video"
        : c.documentMessage
          ? "document"
          : "sticker";
  const anyNode = node as {
    mimetype?: string;
    mediaKey?: Uint8Array;
    directPath?: string;
    url?: string;
    fileLength?: number | { toNumber(): number };
    seconds?: number;
    ptt?: boolean;
    caption?: string;
    fileName?: string;
  };
  const fileLength = typeof anyNode.fileLength === "object" ? anyNode.fileLength.toNumber() : (anyNode.fileLength ?? null);
  const seconds = anyNode.seconds ?? null;
  const stub: Omit<MediaRow, "chat_jid" | "msg_id" | "timestamp"> = {
    kind,
    mimetype: anyNode.mimetype ?? null,
    media_key: anyNode.mediaKey ? Buffer.from(anyNode.mediaKey).toString("base64") : null,
    direct_path: anyNode.directPath ?? null,
    url: anyNode.url ?? null,
    file_length: fileLength,
    seconds,
    is_ptt: anyNode.ptt ? 1 : 0,
    caption: anyNode.caption ?? anyNode.fileName ?? null,
  };
  const dur = seconds ? ` ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : "";
  const placeholder =
    kind === "image"
      ? `[imagen${anyNode.caption ? `: ${anyNode.caption}` : ""}] usa view_image(message_id)`
      : kind === "audio"
        ? `[${anyNode.ptt ? "nota de voz" : "audio"}${dur}] usa transcribe_audio(message_id)`
        : kind === "video"
          ? `[video${dur}${anyNode.caption ? `: ${anyNode.caption}` : ""}] usa view_image(message_id)`
          : kind === "sticker"
            ? `[sticker]`
            : `[documento${anyNode.fileName ? `: ${anyNode.fileName}` : ""}]`;
  return { stub, placeholder };
}

export type ConnectionState = "disconnected" | "connecting" | "waiting_qr" | "connected" | "logged_out";

interface ConnectionEvents {
  qr: [string];
  state: [ConnectionState];
  message: [MessageRow];
}

function toMillis(ts: number | { toNumber(): number } | null | undefined): number {
  if (ts == null) return Date.now();
  const n = typeof ts === "number" ? ts : ts.toNumber();
  return n * 1000;
}

/** Extract displayable text from any WhatsApp message shape. */
function extractText(msg: WAMessage): { text: string | null; type: string; quotedId: string | null } {
  const content = msg.message;
  if (!content) return { text: null, type: "unknown", quotedId: null };
  const type = getContentType(content) ?? "unknown";
  const text =
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    content.documentMessage?.caption ??
    null;
  const quotedId = content.extendedTextMessage?.contextInfo?.stanzaId ?? null;
  return { text, type: type.replace(/Message$/, ""), quotedId };
}

/**
 * Owns THE single Baileys WebSocket. Everything that reaches WhatsApp goes
 * through this class; everything that arrives is persisted into the Store.
 */
export class WhatsAppConnection extends EventEmitter<ConnectionEvents> {
  private socket: WASocket | null = null;
  private stopped = false;
  private reconnectAttempts = 0;

  state: ConnectionState = "disconnected";
  latestQr: string | null = null;
  selfJid: string | null = null;

  /** Bounded LRU of recent full messages, keyed "chat|id" — the fast path for media download. */
  private recentMessages = new Map<string, WAMessage>();
  private static readonly RECENT_LIMIT = 200;

  constructor(private store: Store) {
    super();
  }

  private setState(state: ConnectionState): void {
    this.state = state;
    if (state !== "waiting_qr") this.latestQr = null;
    this.emit("state", state);
  }

  async start(): Promise<void> {
    ensureDirs();
    this.stopped = false;
    this.setState("connecting");

    const logger = pino({ level: "silent" });
    const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined as unknown as [number, number, number] }));

    const socket = makeWASocket({
      version,
      logger,
      auth: {
        creds: authState.creds,
        keys: makeCacheableSignalKeyStore(authState.keys, logger),
      },
      browser: Browsers.macOS("Wacon"),
      syncFullHistory: true,
      markOnlineOnConnect: false,
    });
    this.socket = socket;

    socket.ev.on("creds.update", saveCreds);

    socket.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        this.latestQr = qr;
        this.setState("waiting_qr");
        this.emit("qr", qr);
      }
      if (connection === "open") {
        this.reconnectAttempts = 0;
        this.selfJid = socket.user?.id ? jidNormalizedUser(socket.user.id) : null;
        this.setState("connected");
      }
      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output
          ?.statusCode;
        if (statusCode === DisconnectReason.loggedOut) {
          this.setState("logged_out");
          return;
        }
        if (this.stopped) {
          this.setState("disconnected");
          return;
        }
        // Reconnect with exponential backoff, capped at 60s.
        const delay = Math.min(60_000, 2_000 * 2 ** this.reconnectAttempts++);
        this.setState("connecting");
        setTimeout(() => void this.start().catch(() => this.setState("disconnected")), delay);
      }
    });

    socket.ev.on("messaging-history.set", ({ chats, contacts, messages, lidPnMappings }) => {
      for (const m of lidPnMappings ?? []) this.store.mapJids(m.lid, m.pn);
      for (const chat of chats) {
        if (!chat.id) continue;
        this.store.upsertChat({
          jid: chat.id,
          name: chat.name ?? null,
          unreadCount: chat.unreadCount ?? undefined,
          lastMessageTs: chat.conversationTimestamp ? toMillis(chat.conversationTimestamp) : null,
        });
      }
      for (const contact of contacts) this.linkContact(contact);
      this.store.insertMessages(messages.map((m) => this.toRow(m)).filter((m): m is MessageRow => m !== null));
    });

    // Per-message alt keys are the richest mapping source (every 1:1 message
    // carries the counterpart address). Capture them before anything else.
    socket.ev.on("lid-mapping.update", (m) => {
      if (m?.lid && m?.pn) this.store.mapJids(m.lid, m.pn);
    });

    socket.ev.on("chats.upsert", (chats) => {
      for (const chat of chats) {
        if (!chat.id) continue;
        this.store.upsertChat({
          jid: chat.id,
          name: chat.name ?? null,
          unreadCount: chat.unreadCount ?? undefined,
          lastMessageTs: chat.conversationTimestamp ? toMillis(chat.conversationTimestamp) : null,
        });
      }
    });

    socket.ev.on("contacts.upsert", (contacts) => {
      for (const contact of contacts) this.linkContact(contact);
    });

    socket.ev.on("messages.upsert", ({ messages }) => {
      for (const msg of messages) {
        this.captureAltMapping(msg);
        const row = this.toRow(msg);
        if (!row) continue;
        this.store.insertMessage(row);
        this.store.upsertChat({ jid: row.chat_jid, lastMessageTs: row.timestamp });
        if (msg.pushName && row.sender_jid && !row.from_me) {
          this.store.upsertContact({ jid: row.sender_jid, notifyName: msg.pushName });
        }
        // Capture media: persist the downloadable stub and keep the full
        // message in the LRU so an agent can view/transcribe it shortly after.
        const { stub } = extractMedia(msg);
        if (stub) {
          this.store.upsertMedia({ chat_jid: row.chat_jid, msg_id: row.id, timestamp: row.timestamp, ...stub });
          this.cacheMessage(row.chat_jid, row.id, msg);
        }
        this.emit("message", row);
      }
    });
  }

  /**
   * Store a contact under BOTH its phone JID and its @lid, map them, and give
   * the @lid chat the contact's name — so an agent can find "Nayda" whether
   * they pass her number, her @lid, or her name.
   */
  private linkContact(contact: { id?: string; lid?: string; phoneNumber?: string; name?: string | null; notify?: string | null }): void {
    const name = contact.name ?? null;
    const notify = contact.notify ?? null;
    const pn = contact.phoneNumber ?? (contact.id?.endsWith("@s.whatsapp.net") ? contact.id : undefined);
    const lid = contact.lid ?? (contact.id?.endsWith("@lid") ? contact.id : undefined);
    if (contact.id) this.store.upsertContact({ jid: contact.id, name, notifyName: notify });
    if (pn && lid) {
      this.store.mapJids(lid, pn);
      // Mirror the name onto both identities and onto the @lid chat.
      this.store.upsertContact({ jid: pn, name, notifyName: notify });
      this.store.upsertContact({ jid: lid, name, notifyName: notify });
      if (name) this.store.upsertChat({ jid: lid, name });
    }
  }

  /** Every 1:1 message carries the counterpart address in key.remoteJidAlt. */
  private captureAltMapping(msg: WAMessage): void {
    const key = msg.key as { remoteJid?: string; remoteJidAlt?: string; participant?: string; participantAlt?: string };
    const pair = (a?: string, b?: string) => {
      if (!a || !b) return;
      const lid = a.endsWith("@lid") ? a : b.endsWith("@lid") ? b : null;
      const pn = a.endsWith("@s.whatsapp.net") ? a : b.endsWith("@s.whatsapp.net") ? b : null;
      if (lid && pn) this.store.mapJids(lid, pn);
    };
    pair(key.remoteJid, key.remoteJidAlt);
    pair(key.participant, key.participantAlt);
  }

  private cacheMessage(chatJid: string, id: string, msg: WAMessage): void {
    const key = `${chatJid}|${id}`;
    this.recentMessages.delete(key);
    this.recentMessages.set(key, msg);
    while (this.recentMessages.size > WhatsAppConnection.RECENT_LIMIT) {
      const oldest = this.recentMessages.keys().next().value;
      if (oldest === undefined) break;
      this.recentMessages.delete(oldest);
    }
  }

  private toRow(msg: WAMessage): MessageRow | null {
    const chatJid = msg.key.remoteJid;
    const id = msg.key.id;
    if (!chatJid || !id || chatJid === "status@broadcast") return null;
    const { text, type, quotedId } = extractText(msg);
    const fromMe = msg.key.fromMe ? 1 : 0;
    const senderJid = fromMe
      ? this.selfJid
      : chatJid.endsWith("@g.us")
        ? (msg.key.participant ?? null)
        : chatJid;
    // For media without a caption, store a placeholder as the text so the chat
    // reads coherently and the agent knows to inspect it (view_image/transcribe_audio).
    let displayText = text;
    if (!displayText) {
      const { placeholder } = extractMedia(msg);
      displayText = placeholder;
    }
    return {
      id,
      chat_jid: chatJid,
      sender_jid: senderJid,
      from_me: fromMe,
      timestamp: toMillis(msg.messageTimestamp),
      text: displayText,
      message_type: type,
      quoted_id: quotedId,
    };
  }

  /**
   * Download a media message's bytes. Fast path: the cached full WAMessage via
   * downloadMediaMessage (with reupload retry if WhatsApp's URL expired).
   * Throws on failure — callers wrap this with the anti-fraud error handling.
   */
  async downloadMedia(chatJid: string, msgId: string): Promise<{ buffer: Buffer; mimetype: string | null; kind: string }> {
    const stub = this.store.getMedia(chatJid, msgId);
    if (!stub) throw new Error(`No media stub for ${chatJid}/${msgId}`);
    const socket = this.socket;
    const cached = this.recentMessages.get(`${chatJid}|${msgId}`);
    if (cached && socket) {
      const buffer = (await downloadMediaMessage(
        cached,
        "buffer",
        {},
        { logger: pino({ level: "silent" }), reuploadRequest: socket.updateMediaMessage }
      )) as Buffer;
      return { buffer, mimetype: stub.mimetype, kind: stub.kind };
    }
    // Fallback: reconstruct a minimal message from the persisted stub.
    if (!cached) {
      const reconstructed = this.messageFromStub(chatJid, msgId, stub);
      if (reconstructed && socket) {
        const buffer = (await downloadMediaMessage(
          reconstructed,
          "buffer",
          {},
          { logger: pino({ level: "silent" }), reuploadRequest: socket.updateMediaMessage }
        )) as Buffer;
        return { buffer, mimetype: stub.mimetype, kind: stub.kind };
      }
    }
    throw new Error("media unavailable (not cached and no live socket)");
  }

  /** Rebuild a downloadable WAMessage from a persisted stub (post-restart path). */
  private messageFromStub(chatJid: string, msgId: string, stub: MediaRow): WAMessage | null {
    if (!stub.media_key || !stub.direct_path) return null;
    const node = {
      url: stub.url ?? undefined,
      directPath: stub.direct_path,
      mediaKey: new Uint8Array(Buffer.from(stub.media_key, "base64")),
      mimetype: stub.mimetype ?? undefined,
      fileLength: stub.file_length ?? undefined,
    };
    const key = `${stub.kind}Message` as const;
    return {
      key: { remoteJid: chatJid, id: msgId, fromMe: false },
      message: { [key]: node },
    } as unknown as WAMessage;
  }

  private requireSocket(): WASocket {
    if (!this.socket || this.state !== "connected") {
      throw new Error(`Not connected to WhatsApp (state: ${this.state}). Run login first.`);
    }
    return this.socket;
  }

  /**
   * @param typingMs simulate typing for this long before sending. Real people
   *   don't reply instantly with a paragraph; the contact sees "escribiendo...".
   */
  async sendText(chatJid: string, text: string, typingMs = 0): Promise<{ id: string | null }> {
    const socket = this.requireSocket();
    if (typingMs > 0) {
      await socket.sendPresenceUpdate("composing", chatJid);
      await new Promise((r) => setTimeout(r, Math.min(typingMs, 15_000)));
      await socket.sendPresenceUpdate("paused", chatJid);
    }
    const result = await socket.sendMessage(chatJid, { text });
    return { id: result?.key?.id ?? null };
  }

  /**
   * Controls whether the user appears online to their contacts.
   * 'unavailable' is stealth mode: Wacon keeps receiving everything while the
   * account looks offline — nobody sees "en línea" at 3am because an agent woke up.
   */
  async setPresence(presence: WAPresence, chatJid?: string): Promise<void> {
    await this.requireSocket().sendPresenceUpdate(presence, chatJid);
    if (!chatJid) this.presence = presence;
  }

  presence: WAPresence = "unavailable";

  /** Explicit blue ticks. Reading via Wacon does NOT mark as read unless asked. */
  async markRead(chatJid: string, messages: { id: string; participant?: string | null }[]): Promise<void> {
    const socket = this.requireSocket();
    await socket.readMessages(
      messages.map((m) => ({
        remoteJid: chatJid,
        id: m.id,
        participant: m.participant ?? undefined,
        fromMe: false,
      }))
    );
  }

  async groupMetadata(groupJid: string): Promise<GroupMetadata> {
    if (!this.socket || this.state !== "connected") {
      throw new Error(`Not connected to WhatsApp (state: ${this.state}).`);
    }
    return this.socket.groupMetadata(groupJid);
  }

  async logout(): Promise<void> {
    this.stopped = true;
    try {
      await this.socket?.logout();
    } catch {
      // socket may already be dead; we still clear local creds
    }
    rmSync(AUTH_DIR, { recursive: true, force: true });
    ensureDirs();
    this.setState("logged_out");
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.socket?.end(undefined);
    this.setState("disconnected");
  }
}
