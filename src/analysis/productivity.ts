import type { Store } from "../core/store.js";
import { isAuthoredText } from "../memory/analyzer.js";

/**
 * Productivity layer. Wacon isn't only for replying — most of the value is
 * helping someone get on top of a backlog: what still needs an answer, what
 * they promised and never delivered, what's coming up. All deterministic.
 */

export interface PendingReply {
  chat: string;
  name: string | null;
  isGroup: boolean;
  waitingHours: number;
  unansweredCount: number;
  lastMessage: string | null;
  priority: number;
  reasons: string[];
}

/**
 * Rank what the user owes a reply to. Priority blends how long they've been
 * waiting, how many messages piled up, whether it's a 1:1, and whether the last
 * message actually asks something — so an unanswered question from a friend
 * outranks a group broadcast.
 */
export function pendingReplies(store: Store, opts: { limit?: number; includeGroups?: boolean } = {}): PendingReply[] {
  const rows = store.pendingReplies(opts.limit ?? 40, opts.includeGroups ?? false);
  return rows
    .map((r) => {
      const reasons: string[] = [];
      let priority = 0;
      if (!r.is_group) {
        priority += 35;
        reasons.push("chat directo");
      }
      if (r.last_text?.includes("?")) {
        priority += 25;
        reasons.push("te preguntaron algo");
      }
      if (r.incoming_since > 1) {
        priority += Math.min(20, r.incoming_since * 4);
        reasons.push(`${r.incoming_since} mensajes sin responder`);
      }
      // Waiting longer matters, but with diminishing weight — a 3-month-old
      // thread isn't more urgent than yesterday's, just older.
      if (r.waiting_hours <= 48) {
        priority += 20;
        reasons.push("reciente");
      } else if (r.waiting_hours <= 24 * 7) {
        priority += 10;
      }
      return {
        chat: r.chat_jid,
        name: r.display_name,
        isGroup: !!r.is_group,
        waitingHours: r.waiting_hours,
        unansweredCount: r.incoming_since,
        lastMessage: r.last_text ? r.last_text.slice(0, 120) : null,
        priority: Math.min(100, priority),
        reasons,
      };
    })
    .sort((a, b) => b.priority - a.priority || a.waitingHours - b.waitingHours);
}

export interface Commitment {
  chat: string;
  name: string | null;
  at: string;
  text: string;
  ageDays: number;
}

/** Phrases where the user promised to do something. */
const PROMISE_RE =
  /\b(te (aviso|confirmo|escribo|mando|env[ií]o|paso|digo|cuento)|luego te|mañana te|ahorita te|al rato te|yo te (aviso|confirmo|mando|paso)|lo reviso|lo veo y te|te lo (mando|paso|env[ií]o)|quedamos en que|prometo)\b/i;

/**
 * Promises the user made that they may never have followed through on: a
 * promise message with no further outgoing message in that chat afterwards.
 */
export function openCommitments(store: Store, sinceDays = 21): Commitment[] {
  const candidates = store.commitmentCandidates(sinceDays, 400);
  // Latest outgoing timestamp per chat tells us whether they wrote again after promising.
  const lastOutgoing = new Map<string, number>();
  for (const c of candidates) {
    const prev = lastOutgoing.get(c.chat_jid) ?? 0;
    if (c.timestamp > prev) lastOutgoing.set(c.chat_jid, c.timestamp);
  }
  const out: Commitment[] = [];
  const seenChats = new Set<string>();
  for (const c of candidates) {
    if (!isAuthoredText(c.text) || !PROMISE_RE.test(c.text)) continue;
    // Only surface the promise if it was the user's LAST word in that chat —
    // otherwise they kept talking and probably handled it.
    if (lastOutgoing.get(c.chat_jid) !== c.timestamp) continue;
    if (seenChats.has(c.chat_jid)) continue;
    seenChats.add(c.chat_jid);
    out.push({
      chat: c.chat_jid,
      name: c.display_name,
      at: new Date(c.timestamp).toISOString(),
      text: c.text.slice(0, 140),
      ageDays: Math.round((Date.now() - c.timestamp) / 86_400_000),
    });
  }
  return out.sort((a, b) => b.ageDays - a.ageDays);
}
