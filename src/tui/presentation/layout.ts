import type { TimelineItem } from "../domain/timeline.js";
import { isMedia, isOpenable, mediaLabel, type ChatMessage } from "../domain/message.js";
import { clock } from "../domain/time.js";
import { cells, padCells, truncate, wrap } from "../domain/text.js";
import { colorIndex } from "../domain/chat.js";
import { theme } from "./theme.js";

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

export interface LayoutOptions {
  width: number;
  isGroup: boolean;
  memberNames: Record<string, string>;
  selectedId: string | null;
  now: number;
}

const FLASH_MS = 2200;

const statusMark = (m: ChatMessage): Part[] => {
  if (!m.fromMe) return [];
  if (m.status === "pending") return [{ text: " ◷", color: theme.muted }];
  if (m.status === "failed") return [{ text: " ✗", color: theme.error, bold: true }];
  return [{ text: " ✓", color: theme.tick }];
};

export function layoutConversation(items: TimelineItem[], o: LayoutOptions): ConversationLayout {
  const lines: Line[] = [];
  const spans = new Map<string, [number, number]>();
  // Bubbles take ~3/4 of the pane, like WhatsApp; never less than 18 cells.
  const maxBubble = Math.max(18, Math.min(o.width - 6, Math.floor(o.width * 0.75)));
  const inner = maxBubble - 2;

  for (const item of items) {
    if (item.type === "day") {
      lines.push({ key: `${item.key}-gap`, align: "center", parts: [{ text: " " }] });
      lines.push({ key: item.key, align: "center", parts: [{ text: ` ${item.label} `, color: theme.muted, bg: theme.chip }] });
      continue;
    }
    if (item.type === "unread") {
      const label = ` ${item.count} ${item.count === 1 ? "MENSAJE NO LEÍDO" : "MENSAJES NO LEÍDOS"} `;
      lines.push({ key: `${item.key}-gap`, align: "center", parts: [{ text: " " }] });
      lines.push({ key: item.key, align: "center", parts: [{ text: label, color: theme.accentSoft, bg: theme.chip, bold: true }] });
      continue;
    }

    const m = item.msg;
    const start = lines.length;
    if (item.first) lines.push({ key: `${m.id}-gap`, align: "left", parts: [{ text: " " }] });

    const selected = o.selectedId === m.id;
    const flashing = !!m.arrivedAt && o.now - m.arrivedAt < FLASH_MS;
    const bg = selected ? theme.rowSelected : flashing ? theme.bubbleFlash : m.fromMe ? theme.bubbleOut : theme.bubbleIn;

    // Content lines.
    const body: Part[][] = [];
    if (o.isGroup && !m.fromMe && item.first) {
      const name = (m.senderJid && o.memberNames[m.senderJid]) || (m.senderJid ? `~${m.senderJid.split("@")[0]?.slice(-4)}` : "~");
      const color = theme.people[colorIndex(m.senderJid ?? name, theme.people.length)];
      body.push([{ text: truncate(name, inner), color, bold: true }]);
    }
    if (isMedia(m.kind)) {
      const label = mediaLabel(m.kind, m.kind === "voice" || m.kind === "audio" ? m.text : "");
      body.push([{ text: truncate(label, inner), color: theme.text, bold: true }]);
      const caption = m.kind === "voice" || m.kind === "audio" ? "" : m.text;
      for (const l of caption ? wrap(caption, inner) : []) body.push([{ text: l, color: theme.text }]);
      if (selected && isOpenable(m.kind)) body.push([{ text: "↵ abrir", color: theme.accentSoft }]);
    } else {
      for (const l of wrap(m.text || " ", inner)) body.push([{ text: l, color: theme.text }]);
    }

    // Meta (time + ticks) sits at the end of the last line when it fits.
    const meta: Part[] = [{ text: clock(m.ts), color: m.fromMe ? "#a9d6cc" : theme.muted }, ...statusMark(m)];
    const metaW = meta.reduce((n, p) => n + cells(p.text), 0);
    const widthOf = (row: Part[]) => row.reduce((n, p) => n + cells(p.text), 0);
    const widest = Math.max(...body.map(widthOf));
    const lastW = widthOf(body[body.length - 1]!);
    let contentW: number;
    if (lastW + 2 + metaW <= inner) {
      contentW = Math.max(widest, lastW + 2 + metaW);
      const last = body[body.length - 1]!;
      last.push({ text: " ".repeat(contentW - lastW - metaW) }, ...meta);
    } else {
      contentW = Math.max(widest, metaW);
      body.push([{ text: " ".repeat(contentW - metaW) }, ...meta]);
    }

    body.forEach((row, i) => {
      const fill = contentW - widthOf(row);
      const parts: Part[] = [{ text: " " }, ...row, { text: " ".repeat(Math.max(0, fill) + 1) }].map((p) => ({ ...p, bg }));
      lines.push({ key: `${m.id}-${i}`, align: m.fromMe ? "right" : "left", parts });
    });
    if (m.status === "failed") {
      lines.push({ key: `${m.id}-err`, align: "right", parts: [{ text: truncate(`no enviado · Ctrl+R reintenta${m.error ? ` · ${m.error}` : ""}`, o.width - 2), color: theme.error, italic: true }] });
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
