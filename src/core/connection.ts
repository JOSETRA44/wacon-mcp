import makeWASocket, {
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
  getContentType,
  jidNormalizedUser,
  type WASocket,
  type WAMessage,
  type GroupMetadata,
} from "@whiskeysockets/baileys";
import { EventEmitter } from "node:events";
import { rmSync } from "node:fs";
import pino from "pino";
import { AUTH_DIR, ensureDirs } from "./paths.js";
import type { Store, MessageRow } from "./store.js";

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

    socket.ev.on("messaging-history.set", ({ chats, contacts, messages }) => {
      for (const chat of chats) {
        if (!chat.id) continue;
        this.store.upsertChat({
          jid: chat.id,
          name: chat.name ?? null,
          unreadCount: chat.unreadCount ?? undefined,
          lastMessageTs: chat.conversationTimestamp ? toMillis(chat.conversationTimestamp) : null,
        });
      }
      for (const contact of contacts) {
        this.store.upsertContact({ jid: contact.id, name: contact.name ?? null, notifyName: contact.notify ?? null });
      }
      this.store.insertMessages(messages.map((m) => this.toRow(m)).filter((m): m is MessageRow => m !== null));
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
      for (const contact of contacts) {
        this.store.upsertContact({ jid: contact.id, name: contact.name ?? null, notifyName: contact.notify ?? null });
      }
    });

    socket.ev.on("messages.upsert", ({ messages }) => {
      for (const msg of messages) {
        const row = this.toRow(msg);
        if (!row) continue;
        this.store.insertMessage(row);
        this.store.upsertChat({ jid: row.chat_jid, lastMessageTs: row.timestamp });
        if (msg.pushName && row.sender_jid && !row.from_me) {
          this.store.upsertContact({ jid: row.sender_jid, notifyName: msg.pushName });
        }
        this.emit("message", row);
      }
    });
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
    return {
      id,
      chat_jid: chatJid,
      sender_jid: senderJid,
      from_me: fromMe,
      timestamp: toMillis(msg.messageTimestamp),
      text,
      message_type: type,
      quoted_id: quotedId,
    };
  }

  async sendText(chatJid: string, text: string): Promise<{ id: string | null }> {
    if (!this.socket || this.state !== "connected") {
      throw new Error(`Not connected to WhatsApp (state: ${this.state}). Run login first.`);
    }
    const result = await this.socket.sendMessage(chatJid, { text });
    return { id: result?.key?.id ?? null };
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
