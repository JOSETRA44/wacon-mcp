import makeWASocket, {
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
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import { AUTH_DIR, ensureDirs } from "./paths.js";
import { useWaconAuthState } from "./auth-state.js";
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

/** The message a reply quotes, as much as WhatsApp needs to render the quote. */
export interface QuotedRef {
  id: string;
  fromMe: boolean;
  /** Author in a group; null in a 1:1. */
  participant: string | null;
  text: string | null;
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
export function extractText(msg: WAMessage): { text: string | null; type: string; quotedId: string | null } {
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
  // A reply can be ANY kind of message (a photo answering a question, a voice
  // note answering a photo); each carries contextInfo on its own node. Reading
  // only extendedTextMessage lost every non-text reply.
  let quotedId: string | null = null;
  for (const node of Object.values(content)) {
    const id = (node as { contextInfo?: { stanzaId?: string | null } } | null)?.contextInfo?.stanzaId;
    if (id) {
      quotedId = id;
      break;
    }
  }
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
  /**
   * Bumped on every start(). Ending a socket makes it emit a late `close`,
   * which would otherwise let a dead socket overwrite the state of the live
   * one it was just replaced by (relogin's QR turning back into "disconnected").
   */
  private generation = 0;
  /**
   * The pending backoff reconnect. It must be cancellable: a timer armed by an
   * earlier close used to fire after relogin()/logout() and spin up a SECOND
   * socket, invalidating the QR being scanned (or reviving a logged-out session).
   */
  private reconnectTimer: NodeJS.Timeout | null = null;

  private cancelReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  state: ConnectionState = "disconnected";
  latestQr: string | null = null;
  selfJid: string | null = null;
  /** Our own @lid — WhatsApp now files the "message yourself" chat under it. */
  selfLid: string | null = null;
  /**
   * Last credential read/write problem, surfaced by `wacon doctor`. A live
   * socket keeps working on creds it already loaded, so this is the only
   * warning the user gets that the session will not survive a restart.
   */
  lastAuthError: string | null = null;

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
    this.cancelReconnect();
    this.stopped = false;
    const generation = ++this.generation;
    this.setState("connecting");

    const logger = pino({ level: "silent" });
    const { state: authState, saveCreds, corruption } = await useWaconAuthState(AUTH_DIR);
    if (corruption) {
      // Never let this pass quietly: silent credential loss is precisely what
      // made the last outage look like WhatsApp had unlinked the account.
      this.lastAuthError = corruption;
      console.error(`[wacon] credenciales: ${corruption}`);
    }
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

    // A failed credential write used to reject straight into the event loop and
    // take the whole daemon down (the ENOSPC crash). Catching it keeps the live
    // socket — and everything already synced — alive while we flag the problem.
    socket.ev.on("creds.update", () => {
      void saveCreds()
        .then(() => {
          this.lastAuthError = null;
        })
        .catch((err: unknown) => {
          this.lastAuthError = err instanceof Error ? err.message : String(err);
          console.error(`[wacon] no se pudo guardar la sesión: ${this.lastAuthError}`);
        });
    });

    socket.ev.on("connection.update", (update) => {
      if (generation !== this.generation) return; // superseded socket, ignore
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        this.latestQr = qr;
        this.setState("waiting_qr");
        this.emit("qr", qr);
      }
      if (connection === "open") {
        this.reconnectAttempts = 0;
        this.selfJid = socket.user?.id ? jidNormalizedUser(socket.user.id) : null;
        const lid = (socket.user as { lid?: string } | undefined)?.lid;
        this.selfLid = lid ? jidNormalizedUser(lid) : null;
        this.store.setSelf(this.selfJid, this.selfLid);
        this.syncArchiveStateOnce(socket);
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
        this.cancelReconnect();
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          if (this.stopped || generation !== this.generation) return;
          void this.start().catch(() => this.setState("disconnected"));
        }, delay);
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
        if (typeof chat.archived === "boolean") this.store.setArchived(chat.id, chat.archived);
      }
      for (const contact of contacts) this.linkContact(contact);
      this.store.insertMessages(messages.map((m) => this.toRow(m)).filter((m): m is MessageRow => m !== null));
      // History messages carry media too — without this, everything synced from
      // history (stickers, images, audio) would have no downloadable stub.
      for (const msg of messages) {
        this.captureAltMapping(msg);
        this.captureReaction(msg);
        const row = this.toRow(msg);
        if (!row) continue;
        // History-synced messages carry pushName too, same as live ones —
        // without this, every sender who was never messaged live (which is
        // most of a freshly-synced account) never gets a name captured, and
        // shows as a bare jid/number forever.
        if (msg.pushName && row.sender_jid && !row.from_me) {
          this.store.upsertContact({ jid: row.sender_jid, notifyName: msg.pushName });
        }
        const { stub } = extractMedia(msg);
        if (stub) this.store.upsertMedia({ chat_jid: row.chat_jid, msg_id: row.id, timestamp: row.timestamp, ...stub });
      }
    });

    // Per-message alt keys are the richest mapping source (every 1:1 message
    // carries the counterpart address). Capture them before anything else.
    socket.ev.on("lid-mapping.update", (m) => {
      if (m?.lid && m?.pn) this.store.mapJids(m.lid, m.pn);
    });

    // Receipts: how far each of OUR messages got (server → phone → read).
    // Without this the app could only ever say "sent", even when the phone
    // never received the message — exactly how a lost video went unnoticed.
    socket.ev.on("messages.update", (updates) => {
      for (const { key, update } of updates) {
        const status = typeof update?.status === "number" ? update.status : null;
        if (!key?.remoteJid || !key.id || status === null || !key.fromMe) continue;
        this.store.updateMessageStatus(key.remoteJid, key.id, status);
      }
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
        if (typeof chat.archived === "boolean") this.store.setArchived(chat.id, chat.archived);
      }
    });

    // Archiving on the phone is an app-state change: it only ever arrived
    // here, and nothing listened — archived chats sat in the main list.
    socket.ev.on("chats.update", (updates) => {
      for (const u of updates) {
        if (u.id && typeof u.archived === "boolean") {
          this.store.setArchived(u.id, u.archived);
          this.archiveEvents[u.archived ? "archived" : "unarchived"]++;
        }
      }
    });

    socket.ev.on("contacts.upsert", (contacts) => {
      for (const contact of contacts) this.linkContact(contact);
    });

    // Presence arrives per participant: in a 1:1 the key is the contact, in a
    // group it's whichever member's state changed. Storing by participant
    // (not by chat) is what makes group-member presence work too.
    socket.ev.on("presence.update", ({ presences }) => {
      for (const [participant, data] of Object.entries(presences ?? {})) {
        if (!data?.lastKnownPresence) continue;
        this.store.upsertPresence({
          jid: participant,
          state: data.lastKnownPresence,
          lastSeen: data.lastSeen ? toMillis(data.lastSeen) : null,
        });
      }
    });

    socket.ev.on("messages.upsert", ({ messages, type }) => {
      for (const msg of messages) {
        this.captureAltMapping(msg);
        this.captureReaction(msg);
        const row = this.toRow(msg);
        if (!row) continue;
        this.store.insertMessage(row);
        if (row.from_me && typeof msg.status === "number") this.store.updateMessageStatus(row.chat_jid, row.id, msg.status);
        this.store.upsertChat({ jid: row.chat_jid, lastMessageTs: row.timestamp });
        // Only live arrivals ("notify") count; "append" is backfill of
        // messages the phone already knew about. Answering from any device
        // reads the chat, so an outgoing message clears the badge.
        if (type === "notify") {
          if (row.from_me) this.store.clearUnread(row.chat_jid);
          else this.store.bumpUnread(row.chat_jid);
        }
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
      // A refused pair (one half is us) must not mirror its name either.
      if (!this.store.mapJids(lid, pn)) return;
      // Mirror the name onto both identities and onto the @lid chat.
      this.store.upsertContact({ jid: pn, name, notifyName: notify });
      this.store.upsertContact({ jid: lid, name, notifyName: notify });
      if (name) this.store.upsertChat({ jid: lid, name });
    }
  }

  /**
   * Chats archived before Wacon listened for it are only in the phone's app
   * state. Re-reading that collection once from scratch replays every
   * archive action as chats.update. Flagged so it runs a single time.
   */
  /** How many archive changes arrived (diagnostics for the one-off sync). */
  private archiveEvents = { archived: 0, unarchived: 0 };

  private syncArchiveStateOnce(socket: ReturnType<typeof makeWASocket>): void {
    if (this.store.getMeta("archive_resync_v3")) return;
    const s = socket as unknown as {
      resyncAppState?: (c: string[], initial: boolean) => Promise<void>;
      authState?: { keys: { set: (d: Record<string, Record<string, null>>) => Promise<void> } };
    };
    if (!s.resyncAppState || !s.authState) return;
    // Archive actions live in the "regular_low" collection. Forgetting its
    // stored version makes Baileys fetch the full snapshot and replay every
    // action. Not as an "initial sync": those chat updates wait on a history
    // that never comes and are silently dropped.
    setTimeout(() => {
      void (async () => {
        await s.authState!.keys.set({ "app-state-sync-version": { regular_low: null } });
        await s.resyncAppState!(["regular_low"], false);
        this.store.setMeta("archive_resync_v3", String(Date.now()));
        // Baileys flushes its event buffer after the call returns.
        await new Promise((r) => setTimeout(r, 3000));
        console.log(`[wacon] archivados sincronizados: ${this.store.archivedCount()} (eventos: ${this.archiveEvents.archived} archivar, ${this.archiveEvents.unarchived} desarchivar)`);
      })().catch((e: unknown) => console.error(`[wacon] no pude sincronizar los archivados: ${e instanceof Error ? e.message : String(e)}`));
    }, 8_000).unref?.();
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

  /**
   * A reaction is a message whose payload points at another message. Store it
   * as (target, reactor, emoji) — the `reaction` row in messages carries none
   * of that, which is why reactions could never be shown before.
   */
  private captureReaction(msg: WAMessage): void {
    const r = msg.message?.reactionMessage;
    const chatJid = msg.key.remoteJid;
    if (!r?.key?.id || !chatJid) return;
    const fromMe = !!msg.key.fromMe;
    const key = msg.key as { participant?: string | null; participantAlt?: string | null };
    const sender = fromMe ? this.selfJid : chatJid.endsWith("@g.us") ? (key.participant ?? key.participantAlt ?? null) : chatJid;
    if (!sender) return;
    const ms = r.senderTimestampMs;
    const timestamp = ms ? (typeof ms === "number" ? ms : Number(ms.toString())) : toMillis(msg.messageTimestamp);
    this.store.upsertReaction({ chatJid, targetId: r.key.id, senderJid: sender, fromMe, emoji: r.text ?? "", timestamp });
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
    // In groups the author lives in the key, but which field carries it varies
    // between live messages and history sync — check every known spot, since a
    // missing sender means that person can never be profiled.
    const key = msg.key as { participant?: string | null; participantAlt?: string | null };
    const groupSender =
      key.participant ?? key.participantAlt ?? (msg as { participant?: string | null }).participant ?? null;
    const senderJid = fromMe ? this.selfJid : chatJid.endsWith("@g.us") ? groupSender : chatJid;
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
  async sendText(chatJid: string, text: string, typingMs = 0, quoted?: QuotedRef): Promise<{ id: string | null }> {
    const socket = this.requireSocket();
    if (typingMs > 0) {
      await socket.sendPresenceUpdate("composing", chatJid);
      await new Promise((r) => setTimeout(r, Math.min(typingMs, 15_000)));
      await socket.sendPresenceUpdate("paused", chatJid);
    }
    // Baileys builds the quote's contextInfo from a WAMessage; a minimal one
    // (key + text) is enough for the phone to show "↩ Ana: …" above the reply.
    const options = quoted
      ? {
          quoted: {
            key: { remoteJid: chatJid, id: quoted.id, fromMe: quoted.fromMe, participant: quoted.participant ?? undefined },
            message: { conversation: quoted.text ?? "" },
          } as WAMessage,
        }
      : undefined;
    const result = await socket.sendMessage(chatJid, { text }, options);
    return { id: result?.key?.id ?? null };
  }

  /**
   * Whether this account sends read receipts (blue ticks). Baileys already
   * honours it when marking messages read — with receipts off it sends
   * 'read-self', which marks locally without notifying the sender — so this is
   * only for telling the user what to expect.
   */
  async readReceiptsMode(): Promise<"on" | "off" | "unknown"> {
    try {
      const settings = await this.requireSocket().fetchPrivacySettings();
      const value = settings?.readreceipts;
      if (value === "all") return "on";
      if (value === "none") return "off";
      return "unknown";
    } catch {
      return "unknown";
    }
  }

  /** Send arbitrary media (image/video/audio/document) already shaped for Baileys. */
  async sendMedia(chatJid: string, content: Record<string, unknown>): Promise<{ id: string | null }> {
    const socket = this.requireSocket();
    const result = await socket.sendMessage(chatJid, content as never);
    return { id: result?.key?.id ?? null };
  }

  /** React to a message; an empty emoji removes the reaction. */
  async react(chatJid: string, target: { id: string; fromMe: boolean; participant: string | null }, emoji: string): Promise<{ id: string | null }> {
    const socket = this.requireSocket();
    const result = await socket.sendMessage(chatJid, {
      react: { text: emoji, key: { remoteJid: chatJid, id: target.id, fromMe: target.fromMe, participant: target.participant ?? undefined } },
    });
    return { id: result?.key?.id ?? null };
  }

  /** Send a sticker (webp buffer) — WhatsApp renders it as a real sticker. */
  async sendSticker(chatJid: string, webp: Buffer): Promise<{ id: string | null }> {
    const socket = this.requireSocket();
    const result = await socket.sendMessage(chatJid, { sticker: webp });
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

  /**
   * Ask WhatsApp to start streaming someone's online/last-seen state. Presence
   * is push-only: without subscribing, no `presence.update` ever arrives for
   * that contact. The reply comes asynchronously through the event handler,
   * so callers subscribe and then wait.
   */
  async subscribePresence(jid: string): Promise<void> {
    await this.requireSocket().presenceSubscribe(jid);
  }

  /**
   * Whether the ACCOUNT is allowed to see other people's last seen / online.
   * WhatsApp enforces reciprocity: hide yours and you lose the ability to see
   * anyone else's. Reporting this is what keeps "no aparece" from looking like
   * a bug in Wacon when it is really a privacy setting.
   */
  async presencePrivacy(): Promise<{ lastSeen: string | null; online: string | null; canSeeOthers: boolean }> {
    try {
      const s = (await this.requireSocket().fetchPrivacySettings()) as Record<string, string | undefined>;
      const lastSeen = s?.last ?? null;
      return { lastSeen, online: s?.online ?? null, canSeeOthers: lastSeen !== "none" };
    } catch {
      return { lastSeen: null, online: null, canSeeOthers: true };
    }
  }

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

  /**
   * Force a fresh link attempt so a new QR is emitted.
   *
   * `start()` runs exactly once per daemon (at boot), and `logged_out` is a
   * terminal state — no reconnect timer is armed for it. Without this, a
   * daemon that lost its session can never produce another QR, and `wacon
   * login` polls a socket that will never speak again until the process is
   * killed by hand.
   *
   * Credentials are wiped only when the session is genuinely gone
   * (`logged_out`, or an auth dir with no creds.json — the shape a failed
   * write like ENOSPC leaves behind). A merely `connecting`/`disconnected`
   * socket is a transient network problem, and deleting good creds there
   * would turn a hiccup into a re-link.
   */
  async relogin(): Promise<ConnectionState> {
    if (this.state === "connected") return this.state;

    const sessionIsGone = this.state === "logged_out" || !existsSync(join(AUTH_DIR, "creds.json"));

    this.stopped = true;
    this.cancelReconnect();
    try {
      this.socket?.end(undefined);
    } catch {
      // socket may already be dead — we only care that it stops emitting
    }
    this.socket = null;
    this.latestQr = null;
    this.reconnectAttempts = 0;

    if (sessionIsGone) {
      rmSync(AUTH_DIR, { recursive: true, force: true });
      ensureDirs();
    }

    await this.start();
    return this.state;
  }

  async logout(): Promise<void> {
    this.stopped = true;
    this.cancelReconnect();
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
    this.cancelReconnect();
    this.socket?.end(undefined);
    this.setState("disconnected");
  }
}
