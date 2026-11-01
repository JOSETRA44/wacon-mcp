/**
 * Shared links — "¿dónde me mandaron el sheet para llenar?". Full-text search
 * cannot answer it: the tokenizer splits docs.google.com/spreadsheets/… so
 * "sheets" never matches, and people rarely write the word next to the link.
 * Links are found by what they point at instead.
 */

export type LinkKind = "sheets" | "forms" | "docs" | "slides" | "drive" | "meet" | "any";

/** Substrings that identify each kind, in URLs or in attached file names. */
export const LINK_PATTERNS: Record<Exclude<LinkKind, "any">, string[]> = {
  sheets: ["docs.google.com/spreadsheets", "sheets.google.com", "sheets.new", "1drv.ms/x", "onedrive.live.com", ".xlsx", ".xls]", ".xls ", ".csv"],
  forms: ["docs.google.com/forms", "forms.gle", "forms.office.com", "forms.microsoft.com", "typeform.com", "jotform", "surveymonkey", "tally.so"],
  docs: ["docs.google.com/document", "docs.new", "1drv.ms/w", ".docx", ".pdf"],
  slides: ["docs.google.com/presentation", "1drv.ms/p", ".pptx", "canva.com"],
  drive: ["drive.google.com", "dropbox.com", "mega.nz", "wetransfer.com", "1drv.ms"],
  meet: ["meet.google.com", "zoom.us", "teams.microsoft.com", "teams.live.com"],
};

export const LINK_KINDS = ["sheets", "forms", "docs", "slides", "drive", "meet", "any"] as const;

export function patternsFor(kinds: readonly LinkKind[]): string[] {
  if (kinds.length === 0 || kinds.includes("any")) return ["http://", "https://", "www."];
  return [...new Set(kinds.flatMap((k) => LINK_PATTERNS[k as Exclude<LinkKind, "any">] ?? []))];
}

const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+|\bwww\.[^\s<>"')\]]+/gi;

export function extractUrls(text: string | null): string[] {
  return [...new Set((text ?? "").match(URL_RE) ?? [])].map((u) => u.replace(/[.,;:!?]+$/, ""));
}

/** What a link (or attached file name) is, for the result line. */
export function classifyLink(s: string): LinkKind {
  const low = s.toLowerCase();
  for (const k of ["forms", "sheets", "slides", "docs", "meet", "drive"] as const) {
    if (LINK_PATTERNS[k].some((p) => low.includes(p))) return k;
  }
  return "any";
}
