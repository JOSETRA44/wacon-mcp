import stringWidth from "string-width";

/**
 * Word-wrap by terminal CELLS, not characters: an emoji or a CJK glyph is two
 * cells wide, and laying bubbles out by `.length` is what produces ragged,
 * overflowing chat lines. Long words (URLs) are hard-broken.
 */
export function wrap(text: string, width: number): string[] {
  const max = Math.max(1, width);
  const out: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    if (para === "") {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of para.split(/(\s+)/)) {
      if (word === "") continue;
      const candidate = line + word;
      if (stringWidth(candidate) <= max) {
        line = candidate;
        continue;
      }
      if (line.trim()) out.push(line.trimEnd());
      line = /^\s+$/.test(word) ? "" : word;
      // A single word wider than the line: break it by cells.
      while (stringWidth(line) > max) {
        let cut = "";
        for (const ch of line) {
          if (stringWidth(cut + ch) > max) break;
          cut += ch;
        }
        out.push(cut);
        line = line.slice(cut.length);
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

export const cells = (s: string): number => stringWidth(s);

/** Cut to `width` cells, adding an ellipsis when something was dropped. */
export function truncate(s: string, width: number): string {
  if (width <= 0) return "";
  if (stringWidth(s) <= width) return s;
  let out = "";
  for (const ch of s) {
    if (stringWidth(out + ch) > width - 1) break;
    out += ch;
  }
  return `${out}…`;
}

/** Pad to exactly `width` cells (for solid bubble backgrounds). */
export const padCells = (s: string, width: number): string => s + " ".repeat(Math.max(0, width - stringWidth(s)));
