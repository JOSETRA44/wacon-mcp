/**
 * What Wacon already knows about a contact — shown without asking any AI:
 * facts learned from the chats, the profile's notes, tags, and the things
 * the user promised this person.
 */

export interface ContactFact {
  category: string;
  fact: string;
}

export interface Commitment {
  chatJid: string;
  name: string | null;
  text: string;
  ageDays: number;
}

export interface ContactInfo {
  facts: ContactFact[];
  tags: string[];
  /** Non-empty profile notes, by section ("Dinámica", "Temas recurrentes"…). */
  notes: { section: string; lines: string[] }[];
  /** How the user writes to this person, in words ("mensajes cortos, con emojis"). */
  style: string | null;
}

/**
 * The profile body is markdown with `## Section` headings and italic
 * placeholders like `_(Cómo es la relación…)_`; keep only what someone wrote.
 */
export function profileNotes(body: string | null | undefined, maxPerSection = 4): ContactInfo["notes"] {
  if (!body) return [];
  const out: ContactInfo["notes"] = [];
  let current: { section: string; lines: string[] } | null = null;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    const h = /^#{1,6}\s+(.+)$/.exec(line);
    if (h) {
      current = { section: h[1]!.trim(), lines: [] };
      out.push(current);
      continue;
    }
    if (!current || !line || /^_\(.*\)_$/.test(line) || /^<!--/.test(line)) continue;
    if (current.lines.length < maxPerSection) current.lines.push(line.replace(/^[-*]\s+/, ""));
  }
  return out.filter((s) => s.lines.length > 0);
}

/** One readable sentence from the style stats Wacon computes (memory/analyzer StyleStats). */
export function styleSentence(stats: Record<string, unknown> | null | undefined): string | null {
  if (!stats || typeof stats.messageCount !== "number" || stats.messageCount < 5) return null;
  const parts: string[] = [];
  const len = typeof stats.avgMessageLength === "number" ? stats.avgMessageLength : null;
  if (len !== null) parts.push(len < 25 ? "mensajes cortos" : len < 70 ? "mensajes medianos" : "mensajes largos");
  if (stats.formality === "casual") parts.push("tono informal");
  else if (stats.formality === "formal") parts.push("tono formal");
  if (stats.pronounStyle === "usted") parts.push("de usted");
  const emojis = Array.isArray(stats.topEmojis) ? (stats.topEmojis as { emoji: string }[]).slice(0, 3).map((e) => e.emoji).join("") : "";
  if (emojis) parts.push(`emojis ${emojis}`);
  if (typeof stats.laughterStyle === "string" && stats.laughterStyle) parts.push(`ríes con «${stats.laughterStyle}»`);
  return parts.length ? `Le escribes: ${parts.join(", ")}.` : null;
}

/** Commitments with this chat (either half of an @lid/phone pair). */
export function commitmentsFor(all: readonly Commitment[], jids: readonly string[]): Commitment[] {
  const mine = new Set(jids);
  return all.filter((c) => mine.has(c.chatJid));
}

/** The home's "Hoy" lines: computed locally, no tokens. */
export function todayLines(p: { unread: { name: string; unread: number }[]; agendaToday: string[]; commitments: readonly Commitment[] }): string[] {
  const out: string[] = [];
  const u = p.unread.filter((c) => c.unread > 0);
  if (u.length) out.push(`💬 ${u.length} chat${u.length > 1 ? "s" : ""} sin leer: ${u.slice(0, 3).map((c) => c.name).join(", ")}${u.length > 3 ? "…" : ""}`);
  out.push(p.agendaToday.length ? `📅 Hoy: ${p.agendaToday.slice(0, 2).join(" · ")}${p.agendaToday.length > 2 ? ` (+${p.agendaToday.length - 2})` : ""}` : "📅 Nada en tu agenda hoy");
  const c = p.commitments[0];
  if (c) out.push(`⏳ Prometiste a ${c.name ?? "alguien"}: «${c.text.length > 50 ? `${c.text.slice(0, 49)}…` : c.text}» (hace ${c.ageDays} d)${p.commitments.length > 1 ? ` · ${p.commitments.length - 1} más` : ""}`);
  return out;
}
