import type { OverviewRow } from "../domain/chat.js";
import type { MessageKind } from "../domain/message.js";

/**
 * Everything the chat app needs from the outside world, phrased in the app's
 * own terms. The daemon is one implementation (infrastructure/); tests use an
 * in-memory fake. Nothing above this line knows about HTTP, Baileys or SQLite.
 */

export type LinkState = "disconnected" | "connecting" | "waiting_qr" | "connected" | "logged_out";

export interface RawMessage {
  id: string;
  chat_jid: string;
  sender_jid: string | null;
  from_me: number;
  timestamp: number;
  text: string | null;
  message_type: string;
}

export interface IncomingEvent {
  id: string;
  chat: string;
  chatName: string | null;
  from: string | null;
  at: string;
  text: string | null;
  type: string;
}

export type SendOutcome = { ok: true; messageId: string | null } | { ok: false; reason: string };

export type Presence = { status: "online" | "typing" | "recording" | "offline" | "unknown"; lastSeenRelative: string | null };

/** Local file system, for the attach dialog's shell-style Tab completion. */
export interface FilePort {
  /** Entries that complete `partial` (directories end with a separator). */
  complete(partial: string): string[];
  exists(path: string): boolean;
  home(): string;
}

export interface ChatGateway {
  linkState(): Promise<{ state: LinkState; selfName: string | null }>;
  /** Ask for a fresh link attempt (makes a logged-out daemon emit a QR). */
  relink(): Promise<LinkState>;
  qr(): Promise<{ state: LinkState; qr: string | null }>;

  overview(limit: number): Promise<OverviewRow[]>;
  messages(chatJid: string, limit: number, beforeTs?: number): Promise<RawMessage[]>;
  memberNames(groupJid: string): Promise<Record<string, string>>;
  presence(chatJid: string): Promise<Presence>;

  sendText(chatJid: string, text: string): Promise<SendOutcome>;
  sendFile(chatJid: string, path: string, caption?: string): Promise<SendOutcome & { kind?: MessageKind; fileName?: string }>;
  markRead(chatJid: string): Promise<void>;

  /** Long-poll for incoming messages after `cursor`. */
  waitForMessages(cursor: number, timeoutSeconds: number): Promise<{ cursor: number; events: IncomingEvent[] }>;
  currentCursor(): Promise<number>;

  /** Fetch a received media file and hand it to the OS viewer; returns a note to show. */
  openMedia(chatJid: string, messageId: string, kind: MessageKind): Promise<string>;
  fileExists(path: string): boolean;
}
