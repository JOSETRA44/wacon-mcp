import { cleanText, kindOf, mediaLabel, type MessageKind } from "./message.js";

/**
 * A row of the chat list. Built from the daemon's chat overview, then folded
 * so that one person is one row even when WhatsApp splits them into an @lid
 * chat and a phone-number chat.
 */
export interface ChatSummary {
  jid: string;
  /** Other identities whose messages belong to this same conversation. */
  aliases: string[];
  name: string;
  isGroup: boolean;
  unread: number;
  lastTs: number;
  preview: { text: string; fromMe: boolean; senderName: string | null; kind: MessageKind } | null;
}

export interface OverviewRow {
  jid: string;
  is_group: number;
  unread_count: number;
  last_message_ts: number | null;
  display_name: string | null;
  alt_jid: string | null;
  last_text: string | null;
  last_from_me: number | null;
  last_type: string | null;
  last_sender_name: string | null;
}

/** WhatsApp never shows a raw jid to a human — a name, or a formatted number. */
export function displayName(jid: string, name: string | null | undefined): string {
  if (name && name.trim()) return name.trim();
  if (jid.endsWith("@g.us")) return "Grupo sin nombre";
  if (jid.endsWith("@lid")) return "Contacto sin nombre";
  const digits = jid.split("@")[0]?.replace(/\D/g, "") ?? "";
  if (!digits) return jid;
  const groups: string[] = [];
  for (let i = digits.length; i > 0; i -= 3) groups.unshift(digits.slice(Math.max(0, i - 3), i));
  return `+${groups.join(" ")}`;
}

export function toSummary(r: OverviewRow): ChatSummary {
  const kind = kindOf(r.last_type, r.last_text);
  const hasLast = r.last_text !== null || r.last_type !== null;
  return {
    jid: r.jid,
    aliases: r.alt_jid ? [r.alt_jid] : [],
    name: displayName(r.jid, r.display_name),
    isGroup: r.is_group === 1 || r.jid.endsWith("@g.us"),
    unread: Math.max(0, r.unread_count ?? 0),
    lastTs: r.last_message_ts ?? 0,
    preview: hasLast
      ? { text: cleanText(r.last_text, kind), fromMe: r.last_from_me === 1, senderName: r.last_sender_name, kind }
      : null,
  };
}

/**
 * Fold @lid/phone-number twins into one row. The newer half wins (it is the
 * address WhatsApp currently routes to); unread counts add up; the name falls
 * back to whichever half has a real one.
 */
export function foldIdentities(chats: ChatSummary[]): ChatSummary[] {
  const byJid = new Map(chats.map((c) => [c.jid, c]));
  const consumed = new Set<string>();
  const out: ChatSummary[] = [];
  for (const c of chats) {
    if (consumed.has(c.jid)) continue;
    const twin = c.aliases.map((a) => byJid.get(a)).find((t): t is ChatSummary => !!t && !consumed.has(t.jid));
    if (!twin) {
      out.push(c);
      continue;
    }
    consumed.add(c.jid).add(twin.jid);
    const [primary, other] = c.lastTs >= twin.lastTs ? [c, twin] : [twin, c];
    const named = (s: ChatSummary) => !/^(\+|Contacto sin nombre)/.test(s.name);
    out.push({
      ...primary,
      aliases: [...new Set([...primary.aliases, ...other.aliases, other.jid])].filter((j) => j !== primary.jid),
      name: named(primary) ? primary.name : named(other) ? other.name : primary.name,
      unread: primary.unread + other.unread,
      preview: primary.preview ?? other.preview,
    });
  }
  return out;
}

/** WhatsApp orders purely by recency; unread is a badge, never a sort key. */
export const byRecency = (a: ChatSummary, b: ChatSummary): number => b.lastTs - a.lastTs;

const fold = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

/** Accent- and case-insensitive; matches name, number, or the preview text. */
export function matchesQuery(c: ChatSummary, query: string): boolean {
  const q = fold(query.trim());
  if (!q) return true;
  const digits = q.replace(/\D/g, "");
  return (
    fold(c.name).includes(q) ||
    (digits.length >= 3 && [c.jid, ...c.aliases].some((j) => j.includes(digits))) ||
    fold(c.preview?.text ?? "").includes(q)
  );
}

/** The grey second line of a row: "Tú: ok", "Ana: 📷 Foto", "🎤 Nota de voz". */
export function previewLine(c: ChatSummary): string {
  const p = c.preview;
  if (!p) return "";
  const body = mediaLabel(p.kind, p.text).replace(/\s+/g, " ");
  if (p.fromMe) return `Tú: ${body}`;
  if (c.isGroup && p.senderName) return `${p.senderName.split(" ")[0]}: ${body}`;
  return body;
}

/** One or two letters for the avatar. */
export function initials(name: string): string {
  if (name.startsWith("+")) return "#";
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, "").trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0]?.slice(0, 2) ?? "?");
  return letters.toUpperCase();
}

/** Stable per-person colour index — same contact, same colour, every session. */
export function colorIndex(key: string, buckets: number): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return h % buckets;
}
