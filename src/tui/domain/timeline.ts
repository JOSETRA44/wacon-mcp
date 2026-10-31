import type { ChatMessage } from "./message.js";
import { dayLabel, sameDay } from "./time.js";

/**
 * A conversation turned into what the eye reads: day separators, an
 * "unread" marker, and messages grouped into runs by sender. `first`/`last`
 * of a run is what lets the view draw the sender's name once and space the
 * bubbles the way WhatsApp does.
 */
export type TimelineItem =
  | { type: "day"; key: string; label: string }
  | { type: "unread"; key: string; count: number }
  | { type: "msg"; key: string; msg: ChatMessage; first: boolean; last: boolean };

const RUN_GAP_MS = 5 * 60_000; // same sender, >5 min apart → new run

export function buildTimeline(messages: ChatMessage[], now: number, unreadCount = 0): TimelineItem[] {
  const items: TimelineItem[] = [];
  const unreadStart = unreadCount > 0 ? Math.max(0, messages.length - unreadCount) : -1;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    const prev = messages[i - 1];
    const next = messages[i + 1];
    const newDay = !prev || !sameDay(prev.ts, m.ts);
    if (newDay) items.push({ type: "day", key: `day-${m.ts}`, label: dayLabel(m.ts, now) });
    const unreadHere = i === unreadStart;
    if (unreadHere) items.push({ type: "unread", key: `unread-${m.id}`, count: unreadCount });
    const sameRun = (a: ChatMessage | undefined, b: ChatMessage | undefined) =>
      !!a && !!b && a.fromMe === b.fromMe && a.senderJid === b.senderJid && sameDay(a.ts, b.ts) && Math.abs(b.ts - a.ts) < RUN_GAP_MS;
    items.push({
      type: "msg",
      key: m.id,
      msg: m,
      first: newDay || unreadHere || !sameRun(prev, m),
      last: !sameRun(m, next) || i + 1 === unreadStart,
    });
  }
  return items;
}
