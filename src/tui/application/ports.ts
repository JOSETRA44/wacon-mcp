import type { OverviewRow } from "../domain/chat.js";
import type { AgentEvent, DetectedAgent, ModelOption } from "../domain/agent.js";
import type { AgendaEvent, AgendaTask } from "../domain/agenda.js";
import type { Commitment, ContactInfo } from "../domain/contact.js";
import type { MessageKind, RawReaction } from "../domain/message.js";
import type { Preferences } from "../domain/preferences.js";

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
  quoted_id?: string | null;
  /** WhatsApp ack for our own messages (2 server, 3 delivered, 4 read). */
  status?: number | null;
}

export interface IncomingEvent {
  id: string;
  chat: string;
  chatName: string | null;
  from: string | null;
  at: string;
  text: string | null;
  type: string;
  quotedId?: string | null;
}

export type SendOutcome = { ok: true; messageId: string | null } | { ok: false; reason: string };

export interface SearchHit {
  id: string;
  chatJid: string;
  ts: number;
  fromMe: boolean;
  senderJid: string | null;
  snippet: string;
}

export interface StickerOption {
  id: string;
  description: string | null;
}

export type Presence = { status: "online" | "typing" | "recording" | "offline" | "unknown"; lastSeenRelative: string | null };

/** Where the user's look-and-feel choices persist between sessions. */
export interface PreferencesPort {
  load(): Preferences;
  /** Best effort: a failed save must never break the running app. */
  save(prefs: Preferences): void;
  /** Shown to the user so they know which file to hand-edit. */
  location(): string;
}

/** A screen rectangle in terminal cells, 1-based like ANSI cursor addressing. */
export interface CellRect {
  row: number;
  col: number;
  cols: number;
  rows: number;
}

/**
 * Pixel graphics inside the terminal (sixel). `available` is decided once at
 * startup by asking the terminal; when false the app uses the OS viewer.
 */
export interface ImagePort {
  readonly available: boolean;
  /** Draw an image fitted and centred inside `rect`; `background` flattens transparency. */
  draw(data: Uint8Array, rect: CellRect, background?: string): Promise<void>;
  /** Forget what was drawn so the text UI can repaint over it cleanly. */
  release(): void;
}

/** System clipboard ("Copiar texto" on a message). */
export interface ClipboardPort {
  copy(text: string): void;
}

/** Local file system, for the attach dialog's shell-style Tab completion. */
export interface FilePort {
  /** Entries that complete `partial` (directories end with a separator). */
  complete(partial: string): string[];
  exists(path: string): boolean;
  home(): string;
}

/** Daemon-side problems the user must see, not just the log. */
export interface Health {
  /** Last failure saving the WhatsApp session — usually a full disk. */
  authError: string | null;
  freeDiskBytes: number | null;
}

export interface LinkInfo {
  state: LinkState;
  selfName: string | null;
  /** Our own identities (phone jid and @lid): the chat with yourself. */
  selfJids?: string[];
  health?: Health;
}

export interface ChatGateway {
  linkState(): Promise<LinkInfo>;
  /** Ask for a fresh link attempt (makes a logged-out daemon emit a QR). */
  relink(): Promise<LinkState>;
  qr(): Promise<{ state: LinkState; qr: string | null }>;

  overview(limit: number): Promise<OverviewRow[]>;
  messages(chatJid: string, limit: number, beforeTs?: number): Promise<RawMessage[]>;
  memberNames(groupJid: string): Promise<Record<string, string>>;
  presence(chatJid: string): Promise<Presence>;

  /** `replyTo` quotes that message, like swiping to reply on the phone. */
  sendText(chatJid: string, text: string, replyTo?: string): Promise<SendOutcome>;
  /** Reactions on these messages (both halves of an @lid/phone pair). */
  reactions(chatJid: string, messageIds: string[]): Promise<RawReaction[]>;
  /** React as the user; an empty emoji removes the reaction. */
  react(chatJid: string, messageId: string, emoji: string): Promise<SendOutcome>;
  /** Specific messages by id — for quotes that point before what is loaded. */
  messagesByIds(chatJid: string, ids: string[]): Promise<RawMessage[]>;
  sendFile(chatJid: string, path: string, caption?: string): Promise<SendOutcome & { kind?: MessageKind; fileName?: string }>;
  /** Current WhatsApp ack of some of our messages, for live ✓✓. */
  messageStatuses(ids: string[]): Promise<{ id: string; status: number | null }[]>;
  markRead(chatJid: string): Promise<void>;

  /** Full-text search inside one conversation. */
  search(chatJid: string, query: string, limit: number): Promise<SearchHit[]>;
  /** Moods the sticker library is organised by ("risa", "carino"…). */
  stickerMoods(): Promise<string[]>;
  stickers(chatJid: string, mood: string, limit: number): Promise<StickerOption[]>;
  sendSticker(chatJid: string, stickerId: string): Promise<SendOutcome>;
  /** Speak `text` as a real voice note (TTS happens daemon-side). */
  sendVoice(chatJid: string, text: string): Promise<SendOutcome & { seconds?: number }>;

  /** Long-poll for incoming messages after `cursor`. */
  waitForMessages(cursor: number, timeoutSeconds: number): Promise<{ cursor: number; events: IncomingEvent[] }>;
  currentCursor(): Promise<number>;

  /** Bytes of a received image/sticker, for drawing it inside the terminal. */
  fetchMedia(chatJid: string, messageId: string): Promise<{ data: Uint8Array; mimetype: string }>;
  /** Fetch a received media file and hand it to the OS viewer; returns a note to show. */
  openMedia(chatJid: string, messageId: string, kind: MessageKind): Promise<string>;
  fileExists(path: string): boolean;
}

// ── Modo IA ────────────────────────────────────────────────

/** How an agent starts Wacon's own MCP server, so it can read more of the chat. */
export interface McpLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface AgentSessionOptions {
  /** Neutral working directory — never a code repo the agent could edit. */
  cwd: string;
  mcp: McpLaunch;
  /** Model id to run on; absent = the agent's own default. */
  model?: string;
  /** "full" keeps the agent's own MCP servers/skills/tools; "wacon" only Wacon's. */
  power?: "full" | "wacon";
  /** Continue a previous session of this agent (Claude --resume, Codex exec resume). */
  resumeSessionId?: string;
}

export interface ModelList {
  models: ModelOption[];
  /** The agent's default (or current) model, when it says. */
  current: string | null;
}

/**
 * One conversation with one agent about one chat. Turns stream through the
 * `onEvent` given to `open`; `prompt` resolves when the turn is over.
 */
export interface AgentSession {
  prompt(text: string): Promise<void>;
  answerPermission(requestId: string, optionId: string | null): void;
  cancel(): void;
  close(): void;
}

export interface AgentRuntimePort {
  open(agent: DetectedAgent, opts: AgentSessionOptions, onEvent: (e: AgentEvent) => void): AgentSession;
  /** Models the agent offers. May start a short, prompt-less session (ACP) — never spends tokens. */
  models(agent: DetectedAgent, opts: AgentSessionOptions): Promise<ModelList>;
}

export interface AgentCatalogPort {
  /** Agents installed on this machine; `force` skips the cache. */
  detect(force?: boolean): Promise<DetectedAgent[]>;
}

// ── Agenda ─────────────────────────────────────────────────

export interface AgendaData {
  events: AgendaEvent[];
  tasks: AgendaTask[];
  /** Old, never-reviewed date suggestions the user can clear in one go. */
  staleSuggestions: number;
  /** Things the user promised in chats and has not done (local analysis). */
  commitments: Commitment[];
}

export interface AgendaGateway {
  agenda(withinDays: number): Promise<AgendaData>;
  scheduleEvent(input: { title: string; start: string; chat?: string; notes?: string }): Promise<void>;
  addTask(input: { title: string; due?: string; chat?: string; notes?: string }): Promise<void>;
  completeEvent(id: number): Promise<void>;
  cancelEvent(id: number): Promise<void>;
  completeTask(id: number): Promise<void>;
  dismissStaleSuggestions(): Promise<number>;
}

// ── what Wacon knows (no AI) ───────────────────────────────

export interface ContactInfoPort {
  contactInfo(chatJid: string): Promise<ContactInfo>;
  /** The user's open promises across chats (local analysis). */
  commitments(): Promise<Commitment[]>;
}

// ── Modo IA history ────────────────────────────────────────

/** A finished turn, as kept on disk. */
export interface StoredTurn {
  request: string;
  label: string | null;
  text: string;
  thinking: string;
  by: string;
  status: "done" | "error" | "cancelled";
  error?: string;
  at: number;
}

/** A resumable agent session for one scope (chat or home). */
export interface StoredSession {
  agentId: string;
  model: string | null;
  power: "full" | "wacon";
  sessionId: string;
  /** Newest chat message the agent had seen, so a resume sends only the delta. */
  seenTs: number;
}

export interface AgentHistory {
  chats: Record<string, StoredTurn[]>;
  sessions: Record<string, StoredSession>;
  /** Last quota/capacity error per "agentId|model" — the picker warns about it. */
  quota: Record<string, { at: number; message: string }>;
}

export interface AgentHistoryPort {
  load(): AgentHistory;
  save(h: AgentHistory): void;
}
