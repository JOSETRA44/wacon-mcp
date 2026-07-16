import type { MessageRow } from "../core/store.js";

export interface StyleStats {
  messageCount: number;
  avgMessageLength: number;
  topEmojis: { emoji: string; count: number }[];
  laughterStyle: string | null;
  formality: "formal" | "neutral" | "casual";
  formalitySignals: { formal: number; casual: number };
  startsLowercaseRatio: number;
  exclamationRate: number;
  questionRate: number;
  usesFinalPunctuationRatio: number;
  topPhrases: { phrase: string; count: number }[];
  peakHours: number[];
  lastAnalyzedAt: string;
}

const EMOJI_RE = /\p{Extended_Pictographic}/gu;
const LAUGH_PATTERNS: [string, RegExp][] = [
  ["jaja", /\b(?:ja){2,}s?\b/gi],
  ["jeje", /\b(?:je){2,}s?\b/gi],
  ["jsjs", /\bj[sj]{2,}\b/gi],
  ["haha", /\b(?:ha){2,}\b/gi],
  ["xd", /\bxd+\b/gi],
  ["lol", /\blo+l\b/gi],
];

const FORMAL_MARKERS = /\b(usted|estimad[oa]|cordial(?:mente)?|saludos cordiales|buenos d[ií]as|buenas tardes|agradezco|quedo atent[oa]|por favor)\b/gi;
const CASUAL_MARKERS = /\b(we[yi]|bro|amig[oa]|holi|oye|va|sale|chido|genial|dale|obvio|nah|simón|xq|pq|q\b|tqm|ntp|alv)\b/gi;

const STOPWORDS = new Set(
  "de la que el en y a los del se las por un para con no una su al lo como más pero sus le ya o este sí porque esta entre cuando muy sin sobre también me hasta hay donde quien desde todo nos durante todos uno les ni contra otros ese eso ante ellos e esto mí antes algunos qué unos yo otro otras otra él tanto esa estos mucho quienes nada muchos cual poco ella estar estas algunas algo nosotros tu te ti si es son fue ser está the to and of i you it in".split(
    /\s+/
  )
);

function countMatches(texts: string[], re: RegExp): number {
  let n = 0;
  for (const t of texts) n += t.match(re)?.length ?? 0;
  return n;
}

/**
 * Deterministic style analysis over a set of the user's OUTGOING messages.
 * No LLM involved — this runs in milliseconds over thousands of messages,
 * which is what keeps per-contact memory cheap.
 */
export function analyzeStyle(messages: MessageRow[]): StyleStats {
  const texts = messages.map((m) => m.text ?? "").filter((t) => t.length > 0);
  const n = texts.length;

  const emojiCounts = new Map<string, number>();
  for (const t of texts) {
    for (const e of t.match(EMOJI_RE) ?? []) {
      emojiCounts.set(e, (emojiCounts.get(e) ?? 0) + 1);
    }
  }
  const topEmojis = [...emojiCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([emoji, count]) => ({ emoji, count }));

  let laughterStyle: string | null = null;
  let bestLaugh = 0;
  for (const [name, re] of LAUGH_PATTERNS) {
    const count = countMatches(texts, re);
    if (count > bestLaugh) {
      bestLaugh = count;
      laughterStyle = name;
    }
  }

  const formal = countMatches(texts, FORMAL_MARKERS);
  const casual = countMatches(texts, CASUAL_MARKERS) + bestLaugh + topEmojis.reduce((s, e) => s + e.count, 0) / 4;
  const formality: StyleStats["formality"] =
    formal > casual * 1.5 ? "formal" : casual > formal * 1.5 ? "casual" : "neutral";

  const startsLower = texts.filter((t) => /^[a-záéíóúñü]/.test(t)).length;
  const endsWithPunct = texts.filter((t) => /[.!?…]$/.test(t.trim())).length;
  const exclamations = texts.filter((t) => t.includes("!")).length;
  const questions = texts.filter((t) => t.includes("?")).length;

  // Bigram frequency for recurring phrases.
  const bigrams = new Map<string, number>();
  for (const t of texts) {
    const words = t
      .toLowerCase()
      .replace(EMOJI_RE, " ")
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 1 && !STOPWORDS.has(w));
    for (let i = 0; i < words.length - 1; i++) {
      const phrase = `${words[i]} ${words[i + 1]}`;
      bigrams.set(phrase, (bigrams.get(phrase) ?? 0) + 1);
    }
  }
  const topPhrases = [...bigrams.entries()]
    .filter(([, c]) => c >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([phrase, count]) => ({ phrase, count }));

  const hourCounts = new Array<number>(24).fill(0);
  for (const m of messages) {
    const hour = new Date(m.timestamp).getHours();
    hourCounts[hour] = (hourCounts[hour] ?? 0) + 1;
  }
  const peakHours = hourCounts
    .map((count, hour) => ({ hour, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .map((h) => h.hour)
    .sort((a, b) => a - b);

  return {
    messageCount: n,
    avgMessageLength: n === 0 ? 0 : Math.round(texts.reduce((s, t) => s + t.length, 0) / n),
    topEmojis,
    laughterStyle: bestLaugh > 0 ? laughterStyle : null,
    formality,
    formalitySignals: { formal, casual: Math.round(casual) },
    startsLowercaseRatio: n === 0 ? 0 : Number((startsLower / n).toFixed(2)),
    exclamationRate: n === 0 ? 0 : Number((exclamations / n).toFixed(2)),
    questionRate: n === 0 ? 0 : Number((questions / n).toFixed(2)),
    usesFinalPunctuationRatio: n === 0 ? 0 : Number((endsWithPunct / n).toFixed(2)),
    topPhrases,
    peakHours,
    lastAnalyzedAt: new Date().toISOString(),
  };
}

/** Human/agent-readable one-paragraph summary of the stats. */
export function describeStyle(stats: StyleStats): string {
  const parts: string[] = [];
  parts.push(
    `Basado en ${stats.messageCount} mensajes salientes: tono ${stats.formality}, longitud media ${stats.avgMessageLength} caracteres.`
  );
  if (stats.topEmojis.length > 0) {
    parts.push(`Emojis frecuentes: ${stats.topEmojis.map((e) => e.emoji).join(" ")}.`);
  } else {
    parts.push("Casi no usa emojis.");
  }
  if (stats.laughterStyle) parts.push(`Se ríe escribiendo "${stats.laughterStyle}".`);
  parts.push(
    stats.startsLowercaseRatio > 0.6
      ? "Suele empezar los mensajes en minúscula."
      : "Suele empezar los mensajes con mayúscula."
  );
  parts.push(
    stats.usesFinalPunctuationRatio < 0.3
      ? "Casi nunca termina con punto final."
      : "Suele cerrar las frases con puntuación."
  );
  if (stats.topPhrases.length > 0) {
    parts.push(`Frases recurrentes: ${stats.topPhrases.slice(0, 5).map((p) => `"${p.phrase}"`).join(", ")}.`);
  }
  return parts.join(" ");
}
