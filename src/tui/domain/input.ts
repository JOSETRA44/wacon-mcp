/**
 * Pure rules for what the user typed or pasted.
 */

/**
 * Dragging a file onto Windows Terminal (or most terminals) PASTES its path,
 * often quoted. Recognising that is what makes "attach" as easy as WhatsApp
 * Web's drag-and-drop. Returns the clean path, or null when the paste is
 * ordinary text. Existence is checked by the caller — this stays pure.
 */
export function parseDroppedPath(raw: string): string | null {
  let s = raw.trim();
  if (!s || s.includes("\n")) return null;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1).trim();
  if (s.startsWith("file://")) {
    try {
      s = decodeURIComponent(s.replace(/^file:\/\/(localhost)?/, ""));
      if (/^\/[A-Za-z]:\//.test(s)) s = s.slice(1);
    } catch {
      return null;
    }
  }
  // macOS/Linux terminals escape spaces in dropped paths.
  if (!/^[A-Za-z]:[\\/]/.test(s)) s = s.replace(/\\ /g, " ");
  const windows = /^[A-Za-z]:[\\/][^<>:"|?*\n]*$/.test(s) || /^\\\\[^\\]+\\/.test(s);
  const posix = /^(\/|~\/)[^\0\n]*$/.test(s);
  if (!windows && !posix) return null;
  // Needs something that looks like a file name, not just "/" or "C:\".
  return /[\\/][^\\/]+\.[A-Za-z0-9]{1,8}$/.test(s) ? s : null;
}

/** Longest prefix shared by all candidates — what Tab inserts when ambiguous. */
export function commonPrefix(items: string[]): string {
  if (items.length === 0) return "";
  let p = items[0]!;
  for (const s of items.slice(1)) {
    let i = 0;
    while (i < p.length && i < s.length && p[i]!.toLowerCase() === s[i]!.toLowerCase()) i++;
    p = p.slice(0, i);
  }
  return p;
}

export const fileNameOf = (path: string): string => path.split(/[\\/]/).pop() ?? path;
