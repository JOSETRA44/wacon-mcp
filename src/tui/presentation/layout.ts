import type { TimelineItem } from "../domain/timeline.js";
import { isMedia, isOpenable, mediaLabel, type ChatMessage } from "../domain/message.js";
import { clock } from "../domain/time.js";
import { cells, padCells, truncate, wrap } from "../domain/text.js";
import { colorIndex } from "../domain/chat.js";
import type { ResolvedTheme } from "./themes.js";

/**
 * Pure view layout: a timeline becomes terminal LINES with colour runs.
 * Done outside React so it can be measured (for scrolling) and unit-tested,
 * and so React only renders the handful of lines that fit the viewport.
 */

export interface Part {
  text: string;
  color?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
}
export interface Line {
  key: string;
  align: "left" | "right" | "center";
  parts: Part[];
}
export interface ConversationLayout {
  lines: Line[];
  /** Line span of each message, for scrolling a selection into view. */
  spans: Map<string, [start: number, end: number]>;
}

export interface QuotePreview {
  sender: string;
  text: string;
  /** Colour key for the sender (their jid), or null for "you". */
  colorKey: string | null;
}

export interface LayoutOptions {
  width: number;
  isGroup: boolean;
  memberNames: Record<string, string>;
  selectedId: string | null;
  now: number;
  theme: ResolvedTheme;
  /** Resolves a quoted message id to what the quote block shows. */
  quote?: (id: string) => QuotePreview | null;
  /** Messages the AI agent has looked at: they carry a small ✦ by the time. */
  agentRead?: ReadonlySet<string>;
}

const FLASH_MS = 2200;

export function layoutConversation(items: TimelineItem[], o: LayoutOptions): ConversationLayout {
  const { c, filled, compact, prefs } = o.theme;
  const hour12 = prefs.clock === "12h";
  const lines: Line[] = [];
  const spans = new Map<string, [number, number]>();
  // Bubbles take ~3/4 of the pane, like WhatsApp; never less than 18 cells.
  const maxBubble = Math.max(18, Math.min(o.width - 6, Math.floor(o.width * 0.75)));
  const inner = maxBubble - 2;
  const gap = (key: string) => {
    if (!compact) lines.push({ key, align: "left", parts: [{ text: " " }] });
  };
  const personColor = (key: string) => c.people[colorIndex(key, c.people.length)];

  for (const item of items) {
    if (item.type === "day") {
      gap(`${item.key}-gap`);
      lines.push({ key: item.key, align: "center", parts: [{ text: ` ${item.label} `, color: c.muted, bg: c.chip }] });
      continue;
    }
    if (item.type === "unread") {
      const label = ` ${item.count} ${item.count === 1 ? "MENSAJE NO LEÍDO" : "MENSAJES NO LEÍDOS"} `;
      gap(`${item.key}-gap`);
      lines.push({ key: item.key, align: "center", parts: [{ text: label, color: c.accentSoft, bg: c.chip, bold: true }] });
      continue;
    }

    const m = item.msg;
    const start = lines.length;
    if (item.first) gap(`${m.id}-gap`);

    const selected = o.selectedId === m.id;
    const flashing = !!m.arrivedAt && o.now - m.arrivedAt < FLASH_MS;
    const fill = m.fromMe ? c.bubbleOut : c.bubbleIn;
    const bg = selected ? c.rowSelected : flashing ? c.bubbleFlash : filled ? fill : undefined;
    const textColor = m.fromMe ? c.textOut : c.textIn;

    const body: Part[][] = [];
    if (o.isGroup && !m.fromMe && item.first) {
      const name = (m.senderJid && o.memberNames[m.senderJid]) || (m.senderJid ? `~${m.senderJid.split("@")[0]?.slice(-4)}` : "~");
      body.push([{ text: truncate(name, inner), color: personColor(m.senderJid ?? name), bold: true }]);
    }
    // Quote block: a coloured bar, who is quoted, and one line of what they said.
    if (m.quotedId) {
      const q = o.quote?.(m.quotedId) ?? null;
      const qColor = q?.colorKey ? personColor(q.colorKey) : c.accentSoft;
      body.push([{ text: "▎", color: qColor }, { text: truncate(q?.sender ?? "Mensaje citado", inner - 2), color: qColor, bold: true }]);
      body.push([{ text: "▎", color: qColor }, { text: truncate(q?.text || "…", inner - 2), color: c.muted }]);
    }
    if (isMedia(m.kind)) {
      const voice = m.kind === "voice" || m.kind === "audio";
      body.push([{ text: truncate(mediaLabel(m.kind, voice ? m.text : ""), inner), color: textColor, bold: true }]);
      const caption = voice ? "" : m.text;
      for (const l of caption ? wrap(caption, inner) : []) body.push([{ text: l, color: textColor }]);
      if (selected && isOpenable(m.kind)) body.push([{ text: "↵ acciones · o abrir", color: c.accentSoft }]);
    } else {
      for (const l of wrap(m.text || " ", inner)) body.push([{ text: l, color: textColor }]);
    }

    // Meta (time + ticks) sits at the end of the last line when it fits.
    const meta: Part[] = [
      ...(o.agentRead?.has(m.id) ? [{ text: "✦ ", color: c.accentSoft }] : []),
      { text: clock(m.ts, hour12), color: m.fromMe ? c.metaOut : c.muted },
    ];
    if (m.fromMe) {
      if (m.status === "pending") meta.push({ text: " ◷", color: c.muted });
      else if (m.status === "failed") meta.push({ text: " ✗", color: c.error, bold: true });
      else if (m.status === "read") meta.push({ text: " ✓✓", color: c.tick });
      else if (m.status === "delivered") meta.push({ text: " ✓✓", color: m.fromMe ? c.metaOut : c.muted });
      else meta.push({ text: " ✓", color: m.fromMe ? c.metaOut : c.muted });
    }
    const widthOf = (row: Part[]) => row.reduce((n, p) => n + cells(p.text), 0);
    const metaW = widthOf(meta);
    const widest = Math.max(...body.map(widthOf));
    const lastW = widthOf(body[body.length - 1]!);
    let contentW: number;
    if (lastW + 2 + metaW <= inner) {
      contentW = Math.max(widest, lastW + 2 + metaW);
      body[body.length - 1]!.push({ text: " ".repeat(contentW - lastW - metaW) }, ...meta);
    } else {
      contentW = Math.max(widest, metaW);
      body.push([{ text: " ".repeat(contentW - metaW) }, ...meta]);
    }

    // Minimal style: no fill, so a thin edge marks whose bubble it is.
    const edgeIn: Part = { text: filled || bg ? " " : "▏", color: c.border };
    const edgeOut: Part = { text: filled || bg ? " " : "▕", color: c.accent };
    body.forEach((row, i) => {
      const pad = contentW - widthOf(row);
      const parts: Part[] = [m.fromMe ? { text: " " } : edgeIn, ...row, { text: " ".repeat(Math.max(0, pad)) }, m.fromMe ? edgeOut : { text: " " }].map((p) => ({ ...p, bg }));
      lines.push({ key: `${m.id}-${i}`, align: m.fromMe ? "right" : "left", parts });
    });

    // Reactions hang under the bubble, like WhatsApp's little pill.
    if (m.reactions?.length) {
      const pills: Part[] = [];
      for (const r of m.reactions.slice(0, 5)) {
        pills.push({ text: ` ${r.emoji}${r.count > 1 ? ` ${r.count}` : ""} `, bg: r.mine ? c.bubbleOut ?? c.rowSelected : c.chip ?? c.rowSelected, color: c.text });
        pills.push({ text: " " });
      }
      lines.push({ key: `${m.id}-react`, align: m.fromMe ? "right" : "left", parts: pills });
    }
    if (m.status === "failed") {
      lines.push({ key: `${m.id}-err`, align: "right", parts: [{ text: truncate(`no enviado · Ctrl+R reintenta${m.error ? ` · ${m.error}` : ""}`, o.width - 2), color: c.error, italic: true }] });
    }
    spans.set(m.id, [start, lines.length - 1]);
  }
  return { lines, spans };
}

/** Exactly `width` cells of a row: left text, right text, gap filled. */
export function spread(left: string, right: string, width: number): [string, string] {
  const r = truncate(right, Math.max(0, width - 1));
  const l = truncate(left, Math.max(0, width - cells(r) - 1));
  return [padCells(l, width - cells(r)), r];
}
