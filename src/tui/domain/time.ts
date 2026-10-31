/**
 * WhatsApp's time vocabulary, in Spanish: the list says "10:21", "ayer",
 * "martes", "12/10/26"; the conversation separates days with "HOY", "AYER".
 * `now` is always injected so every rule is testable.
 */

const startOfDay = (ts: number): number => {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

const DAY = 86_400_000;

/** Whole calendar days between ts and now (0 = today, 1 = yesterday). */
export function daysAgo(ts: number, now: number): number {
  return Math.round((startOfDay(now) - startOfDay(ts)) / DAY);
}

export const clock = (ts: number): string =>
  new Date(ts).toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit", hour12: false });

const WEEKDAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

/** Right-hand timestamp of a chat-list row. */
export function listTime(ts: number, now: number): string {
  if (!ts) return "";
  const d = daysAgo(ts, now);
  if (d <= 0) return clock(ts);
  if (d === 1) return "ayer";
  if (d < 7) return WEEKDAYS[new Date(ts).getDay()]!;
  return new Date(ts).toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "2-digit" });
}

/** Centered day separator inside a conversation. */
export function dayLabel(ts: number, now: number): string {
  const d = daysAgo(ts, now);
  if (d <= 0) return "HOY";
  if (d === 1) return "AYER";
  if (d < 7) return WEEKDAYS[new Date(ts).getDay()]!.toUpperCase();
  return new Date(ts)
    .toLocaleDateString("es-PE", { day: "numeric", month: "long", year: "numeric" })
    .toUpperCase();
}

export const sameDay = (a: number, b: number): boolean => startOfDay(a) === startOfDay(b);
