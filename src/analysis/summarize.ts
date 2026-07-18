import type { MessageRow } from "../core/store.js";

/**
 * Extractive (no-LLM) episode digest: pick the few most informative messages
 * and stitch a short recap. Not as fluent as an LLM summary, but free and
 * instant — so every episode has SOME searchable memory in the RAG from the
 * first pass. Tier-2 agents can later rewrite these into narrative summaries.
 */

const SALIENT_RE = /(\?|\b\d{1,2}\s+de\s+[a-záéíóú]+|\b\d{1,2}[:/]\d{2}|\bmañana\b|\bhoy\b|\bexamen|\bentrega|\bquedamos|\bvamos|\bacord|\bplan\b|\bcita\b)/i;

export function extractiveDigest(messages: MessageRow[], who: (m: MessageRow) => string): string | null {
  const texts = messages.filter((m) => m.text && m.text.length > 2 && !m.text.startsWith("["));
  if (texts.length === 0) return null;

  const scored = texts.map((m, i) => {
    let score = 0;
    if (i === 0) score += 2; // opener sets the topic
    if (SALIENT_RE.test(m.text!)) score += 3; // dates/decisions/questions
    score += Math.min(2, m.text!.length / 60); // longer ~ more substance
    return { m, i, score };
  });

  // Keep the top 3 salient, then restore chronological order for readability.
  const picked = scored
    .slice()
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .sort((a, b) => a.i - b.i)
    .map(({ m }) => `${who(m)}: ${m.text!.replace(/\n/g, " ").slice(0, 100)}`);

  return `[auto] ${picked.join(" · ")}`;
}
