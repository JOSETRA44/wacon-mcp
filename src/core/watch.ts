import { randomBytes } from "node:crypto";
import type { MessageRow, Store } from "./store.js";

/**
 * ATTENTION SUBSYSTEM — the token-saving core of Wacon.
 *
 * An agent that polls `list_chats` every 30s to see "did anything arrive?"
 * burns thousands of tokens per hour to learn "no". Instead the daemon does
 * the waiting (free) and the triage (deterministic, free), and only hands the
 * agent messages worth its attention.
 *
 * Three mechanisms:
 *  1. Rules   — declarative filters an agent registers once.
 *  2. Triage  — deterministic priority score per message (no LLM).
 *  3. Cursor  — a monotonic sequence so an agent never misses events between
 *               calls and never re-reads the same one.
 */

export interface WatchRule {
  /** Only these chats (JIDs). Empty = any chat. */
  chats: string[];
  /** Never wake for these chats. */
  excludeChats: string[];
  /** Wake only if the text matches one of these (case/accent-insensitive). */
  keywords: string[];
  /** Include group chats at all. */
  includeGroups: boolean;
  /** Minimum priority score (0-100) required to wake the agent. */
  minPriority: number;
}

export interface WatchSession extends WatchRule {
  id: string;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  /** Events that matched this session since it started. */
  matched: number;
}

export interface WatchEvent {
  /** Monotonic cursor. Pass the last one you saw to `since` to resume exactly. */
  seq: number;
  message: MessageRow;
  chatName: string | null;
  priority: number;
  reasons: string[];
}

/** A proactive trigger fired by the scheduler when a calendar event's notify time arrives. */
export interface TriggerEvent {
  seq: number;
  kind: "event";
  eventId: number;
  chatJid: string | null;
  chatName: string | null;
  title: string;
  startTs: number;
  minutesUntilStart: number | null;
  notes: string | null;
  firedAt: number;
}

export const DEFAULT_RULE: WatchRule = {
  chats: [],
  excludeChats: [],
  keywords: [],
  includeGroups: false,
  minPriority: 0,
};

/** Bounded buffer: an agent away for hours shouldn't be able to OOM the daemon. */
const BUFFER_SIZE = 300;
/** A watch never outlives this, so a crashed agent can't keep the daemon busy forever. */
export const MAX_WATCH_MINUTES = 240;

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

interface Waiter {
  since: number;
  sessionId: string | null;
  resolve: (events: WatchEvent[]) => void;
  timer: NodeJS.Timeout;
}

interface CombinedWaiter {
  sinceMsg: number;
  sinceTrigger: number;
  resolve: (r: { messages: WatchEvent[]; triggers: TriggerEvent[] }) => void;
  timer: NodeJS.Timeout;
}

export class WatchRegistry {
  private sessions = new Map<string, WatchSession>();
  private buffer: WatchEvent[] = [];
  private waiters = new Set<Waiter>();
  private seq = 0;
  /** Separate stream for proactive triggers (calendar). */
  private triggers: TriggerEvent[] = [];
  private triggerSeq = 0;
  private combinedWaiters = new Set<CombinedWaiter>();
  /** Contacts the user talks to a lot — used for triage. Refreshed lazily. */
  private vipCache: { jids: Set<string>; at: number } | null = null;

  constructor(private store: Store) {}

  get triggerCursor(): number {
    return this.triggerSeq;
  }

  // ── sessions ─────────────────────────────────────────────

  start(rule: Partial<WatchRule>, durationMinutes: number, createdBy: string): WatchSession {
    const minutes = Math.min(Math.max(durationMinutes, 1), MAX_WATCH_MINUTES);
    const session: WatchSession = {
      ...DEFAULT_RULE,
      ...rule,
      id: randomBytes(4).toString("hex"),
      createdBy,
      createdAt: Date.now(),
      expiresAt: Date.now() + minutes * 60_000,
      matched: 0,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  stop(sessionId?: string): number {
    if (sessionId) {
      return this.sessions.delete(sessionId) ? 1 : 0;
    }
    const n = this.sessions.size;
    this.sessions.clear();
    return n;
  }

  activeSessions(): WatchSession[] {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (s.expiresAt <= now) this.sessions.delete(id);
    }
    return [...this.sessions.values()];
  }

  get cursor(): number {
    return this.seq;
  }

  // ── triage ───────────────────────────────────────────────

  private vips(): Set<string> {
    // Cheap to recompute, but not per-message.
    if (this.vipCache && Date.now() - this.vipCache.at < 10 * 60_000) return this.vipCache.jids;
    const jids = new Set(this.store.topChats(15).map((c) => c.chat_jid));
    this.vipCache = { jids, at: Date.now() };
    return jids;
  }

  /**
   * Deterministic importance score. This is what lets the daemon decide
   * "is this worth an agent's tokens?" without asking a model.
   */
  private score(msg: MessageRow, selfJid: string | null): { priority: number; reasons: string[] } {
    const reasons: string[] = [];
    let score = 0;
    const isGroup = msg.chat_jid.endsWith("@g.us");

    if (!isGroup) {
      score += 40;
      reasons.push("direct-chat");
    } else {
      score += 5;
      const mentionsMe = selfJid && msg.text ? msg.text.includes(selfJid.split("@")[0]!) : false;
      if (mentionsMe) {
        score += 45;
        reasons.push("mentions-me");
      }
    }
    if (this.vips().has(msg.chat_jid)) {
      score += 20;
      reasons.push("frequent-contact");
    }
    if (msg.quoted_id) {
      score += 15;
      reasons.push("replies-to-me");
    }
    if (msg.text?.includes("?")) {
      score += 10;
      reasons.push("question");
    }
    if (msg.message_type !== "text" && msg.message_type !== "conversation" && msg.message_type !== "extendedText") {
      score += 5;
      reasons.push(`media:${msg.message_type}`);
    }
    return { priority: Math.min(100, score), reasons };
  }

  private matches(session: WatchSession, event: WatchEvent): boolean {
    const isGroup = event.message.chat_jid.endsWith("@g.us");
    if (isGroup && !session.includeGroups) return false;
    if (session.excludeChats.includes(event.message.chat_jid)) return false;
    if (session.chats.length > 0 && !session.chats.includes(event.message.chat_jid)) return false;
    if (session.keywords.length > 0) {
      const text = normalize(event.message.text ?? "");
      if (!session.keywords.some((k) => text.includes(normalize(k)))) return false;
    }
    return event.priority >= session.minPriority;
  }

  // ── ingestion ────────────────────────────────────────────

  /** Called by the connection for every inbound message. Must stay cheap. */
  ingest(msg: MessageRow, selfJid: string | null): void {
    if (msg.from_me) return; // our own sends never wake an agent
    const { priority, reasons } = this.score(msg, selfJid);
    const event: WatchEvent = {
      seq: ++this.seq,
      message: msg,
      chatName: this.store.resolveDisplayName(msg.chat_jid),
      priority,
      reasons,
    };

    this.buffer.push(event);
    if (this.buffer.length > BUFFER_SIZE) this.buffer.splice(0, this.buffer.length - BUFFER_SIZE);

    for (const session of this.activeSessions()) {
      if (this.matches(session, event)) session.matched++;
    }
    this.flushWaiters();
    this.flushCombined();
  }

  /** Called by the scheduler when a calendar event's notify time arrives. */
  emitTrigger(t: Omit<TriggerEvent, "seq">): TriggerEvent {
    const trigger: TriggerEvent = { ...t, seq: ++this.triggerSeq };
    this.triggers.push(trigger);
    if (this.triggers.length > BUFFER_SIZE) this.triggers.splice(0, this.triggers.length - BUFFER_SIZE);
    this.flushCombined();
    return trigger;
  }

  // ── waiting (long-poll) ──────────────────────────────────

  private eventsFor(sessionId: string | null, since: number): WatchEvent[] {
    const session = sessionId ? this.sessions.get(sessionId) : null;
    if (sessionId && !session) return [];
    return this.buffer.filter((e) => e.seq > since && (!session || this.matches(session, e)));
  }

  private flushWaiters(): void {
    for (const waiter of [...this.waiters]) {
      const events = this.eventsFor(waiter.sessionId, waiter.since);
      if (events.length > 0) {
        clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        waiter.resolve(events);
      }
    }
  }

  /**
   * Resolve immediately if events are already buffered, otherwise block until
   * one arrives or the timeout expires. This single call replaces an entire
   * polling loop in the agent.
   */
  wait(opts: { since?: number; sessionId?: string | null; timeoutMs: number }): Promise<WatchEvent[]> {
    const since = opts.since ?? this.seq;
    const sessionId = opts.sessionId ?? null;
    const existing = this.eventsFor(sessionId, since);
    if (existing.length > 0) return Promise.resolve(existing);

    return new Promise((resolve) => {
      const waiter: Waiter = {
        since,
        sessionId,
        resolve,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          resolve([]);
        }, opts.timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  // ── combined wait (messages + proactive triggers) ────────

  private combinedFor(sinceMsg: number, sinceTrigger: number): { messages: WatchEvent[]; triggers: TriggerEvent[] } {
    return {
      messages: this.buffer.filter((e) => e.seq > sinceMsg),
      triggers: this.triggers.filter((t) => t.seq > sinceTrigger),
    };
  }

  private flushCombined(): void {
    for (const w of [...this.combinedWaiters]) {
      const r = this.combinedFor(w.sinceMsg, w.sinceTrigger);
      if (r.messages.length > 0 || r.triggers.length > 0) {
        clearTimeout(w.timer);
        this.combinedWaiters.delete(w);
        w.resolve(r);
      }
    }
  }

  /**
   * Long-poll for BOTH new inbound messages and proactive triggers. Lets an
   * agent loop (e.g. Claude Code /loop) be woken either by a contact writing OR
   * by a scheduled event's time arriving — the basis of proactive autonomy.
   */
  waitForTriggers(opts: { sinceMsg?: number; sinceTrigger?: number; timeoutMs: number }): Promise<{ messages: WatchEvent[]; triggers: TriggerEvent[]; msgCursor: number; triggerCursor: number }> {
    const sinceMsg = opts.sinceMsg ?? this.seq;
    const sinceTrigger = opts.sinceTrigger ?? this.triggerSeq;
    const build = (r: { messages: WatchEvent[]; triggers: TriggerEvent[] }) => ({
      ...r,
      msgCursor: r.messages.length > 0 ? r.messages[r.messages.length - 1]!.seq : sinceMsg,
      triggerCursor: r.triggers.length > 0 ? r.triggers[r.triggers.length - 1]!.seq : sinceTrigger,
    });
    const existing = this.combinedFor(sinceMsg, sinceTrigger);
    if (existing.messages.length > 0 || existing.triggers.length > 0) return Promise.resolve(build(existing));

    return new Promise((resolve) => {
      const w: CombinedWaiter = {
        sinceMsg,
        sinceTrigger,
        resolve: (r) => resolve(build(r)),
        timer: setTimeout(() => {
          this.combinedWaiters.delete(w);
          resolve(build({ messages: [], triggers: [] }));
        }, opts.timeoutMs),
      };
      this.combinedWaiters.add(w);
    });
  }

  /** Release every blocked waiter (daemon shutdown). */
  releaseAll(): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve([]);
    }
    this.waiters.clear();
    for (const w of this.combinedWaiters) {
      clearTimeout(w.timer);
      w.resolve({ messages: [], triggers: [] });
    }
    this.combinedWaiters.clear();
  }
}
