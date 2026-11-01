import { clock } from "./time.js";

/**
 * The Agenda: what the user has to do and attend, from Wacon's events and
 * tasks — plus what the AI proposes adding. Pure rules; the data comes from
 * the daemon through the AgendaGateway port.
 */

export interface AgendaEvent {
  id: number;
  title: string;
  startTs: number;
  chatJid: string | null;
  status: string;
  notes: string | null;
}

export interface AgendaTask {
  id: number;
  title: string;
  dueTs: number | null;
  chatJid: string | null;
  notes: string | null;
}

export type AgendaItem = ({ kind: "event" } & AgendaEvent) | ({ kind: "task" } & AgendaTask);

export interface AgendaSection {
  label: string;
  /** Overdue tasks get the warning colour. */
  tone: "normal" | "overdue" | "undated";
  items: AgendaItem[];
}

const DAY = 86_400_000;
const startOfDay = (ts: number) => {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const WEEKDAY = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

/** "Hoy", "Mañana", "jueves 6 nov", "15 dic". */
export function agendaDayLabel(ts: number, now: number): string {
  const days = Math.round((startOfDay(ts) - startOfDay(now)) / DAY);
  if (days === 0) return "Hoy";
  if (days === 1) return "Mañana";
  const d = new Date(ts);
  const date = d.toLocaleDateString("es-PE", { day: "numeric", month: "short" }).replace(".", "");
  return days > 1 && days < 7 ? `${WEEKDAY[d.getDay()]} ${date}` : date;
}

const itemTs = (i: AgendaItem): number | null => (i.kind === "event" ? i.startTs : i.dueTs);

/**
 * Sections in reading order: overdue tasks, then each day from today on,
 * then undated tasks. Past events drop out — the agenda looks forward.
 */
export function buildAgenda(events: readonly AgendaEvent[], tasks: readonly AgendaTask[], now: number): AgendaSection[] {
  const today = startOfDay(now);
  const items: AgendaItem[] = [
    ...events.filter((e) => e.startTs >= today && e.status !== "cancelled" && e.status !== "done").map((e) => ({ kind: "event" as const, ...e })),
    ...tasks.map((t) => ({ kind: "task" as const, ...t })),
  ];
  const overdue = items.filter((i) => i.kind === "task" && i.dueTs !== null && i.dueTs < today);
  const undated = items.filter((i) => itemTs(i) === null);
  const dated = items.filter((i) => !overdue.includes(i) && itemTs(i) !== null).sort((a, b) => itemTs(a)! - itemTs(b)!);
  const sections: AgendaSection[] = [];
  if (overdue.length) sections.push({ label: "Vencidas", tone: "overdue", items: overdue });
  for (const i of dated) {
    const label = agendaDayLabel(itemTs(i)!, now);
    const last = sections[sections.length - 1];
    if (last && last.label === label) last.items.push(i);
    else sections.push({ label, tone: "normal", items: [i] });
  }
  if (undated.length) sections.push({ label: "Sin fecha", tone: "undated", items: undated });
  return sections;
}

/** What the home row says about the agenda, at a glance. */
export function agendaSummary(sections: readonly AgendaSection[], now: number, hour12 = false): string {
  const next = sections.find((s) => s.tone === "normal")?.items[0];
  const overdue = sections.find((s) => s.tone === "overdue")?.items.length ?? 0;
  const parts: string[] = [];
  if (overdue) parts.push(`${overdue} vencida${overdue > 1 ? "s" : ""}`);
  if (next) {
    const ts = next.kind === "event" ? next.startTs : next.dueTs!;
    parts.push(`${agendaDayLabel(ts, now)}${next.kind === "event" ? ` ${clock(ts, hour12)}` : ""} · ${next.title}`);
  }
  return parts.length ? parts.join(" · ") : "Nada pendiente · i para buscar fechas en tus chats";
}

// ── proposals from the AI ──────────────────────────────────

/** Something the agent wants to add to the agenda — the user confirms it. */
export interface AgendaProposal {
  kind: "event" | "task";
  title: string;
  /** ISO date/time as the agent gave it; null = no date. */
  when: string | null;
  chatJid: string | null;
  notes: string | null;
}

const str = (input: unknown, key: string): string | null => {
  if (!input || typeof input !== "object") return null;
  const v = (input as Record<string, unknown>)[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
};

/** propose_event / propose_task tool calls → a proposal card. */
export function proposalFrom(tool: string | null, input: unknown): AgendaProposal | null {
  if (tool !== "propose_event" && tool !== "propose_task") return null;
  const title = str(input, "title");
  if (!title) return null;
  const when = tool === "propose_event" ? str(input, "start") : str(input, "due");
  if (tool === "propose_event" && (!when || Number.isNaN(new Date(when).getTime()))) return null; // an event needs a date
  return { kind: tool === "propose_event" ? "event" : "task", title, when: when && !Number.isNaN(new Date(when).getTime()) ? when : null, chatJid: str(input, "chat"), notes: str(input, "notes") };
}

/** One line for a proposal card. */
export function proposalLine(p: AgendaProposal, now: number, hour12 = false): string {
  if (!p.when) return `${p.kind === "event" ? "📅" : "☐"} ${p.title}`;
  const ts = new Date(p.when).getTime();
  const hasTime = /T\d{2}:\d{2}/.test(p.when);
  return `${p.kind === "event" ? "📅" : "☐"} ${agendaDayLabel(ts, now)}${hasTime ? ` ${clock(ts, hour12)}` : ""} · ${p.title}`;
}
