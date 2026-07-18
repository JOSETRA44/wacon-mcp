import type { MessageRow } from "../core/store.js";

export interface RelationshipDynamics {
  /** Median seconds the user takes to reply to this contact. */
  medianReplySeconds: number | null;
  /** Fraction of conversation episodes started by the user (0..1). */
  initiationRatio: number | null;
  /** Average consecutive messages the user sends per turn. */
  avgBurstLength: number;
  /** Messages per week over the analyzed window. */
  messagesPerWeek: number;
}

export interface StyleStats {
  messageCount: number;
  avgMessageLength: number;
  topEmojis: { emoji: string; count: number }[];
  laughterStyle: string | null;
  formality: "formal" | "neutral" | "casual";
  formalitySignals: { formal: number; casual: number };
  /** Dominant address pronoun in Spanish: tú / usted / vos. */
  pronounStyle: "tuteo" | "usted" | "voseo" | null;
  /** Dominant language of the user's messages. */
  language: "es" | "en" | "mixed" | null;
  /** Fraction of messages using accent marks — many people never type tildes in chat. */
  tildeUsage: number;
  /** Chat abbreviations the user actually uses (xq, tqm, ntp...). */
  abbreviations: string[];
  startsLowercaseRatio: number;
  exclamationRate: number;
  questionRate: number;
  usesFinalPunctuationRatio: number;
  topPhrases: { phrase: string; count: number }[];
  peakHours: number[];
  dynamics: RelationshipDynamics | null;
  lastAnalyzedAt: string;
}

/**
 * Text that is NOT the user's own prose and must never shape their style:
 *  - Wacon's own media placeholders ("[imagen] usa view_image(...)") — counting
 *    these was silently teaching the persona to "speak" like our tooling.
 *  - Pasted code/SQL/JSON, which says nothing about how someone chats.
 *  - Bare links.
 */
const PLACEHOLDER_RE = /^\s*\[(imagen|sticker|nota de voz|audio|video|documento)/i;
const CODEISH_RE = /(\bNOT NULL\b|\bDEFAULT\b|\bSELECT\b|\bINSERT\b|\bCREATE TABLE\b|\buuid\b|=>|\bconst\s+\w+\s*=|\bfunction\s*\(|^\s*[{[]|\}\s*;?\s*$|<\/?[a-z]+>)/im;
const LINK_ONLY_RE = /^\s*https?:\/\/\S+\s*$/i;
/** Any URL anywhere in the text — stripped before style analysis. */
const URL_RE = /https?:\/\/\S+|www\.\S+/gi;

/** Whether a message is the user's own conversational writing. */
export function isAuthoredText(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.trim();
  if (t.length === 0) return false;
  if (PLACEHOLDER_RE.test(t)) return false;
  if (LINK_ONLY_RE.test(t)) return false;
  if (CODEISH_RE.test(t)) return false;
  return true;
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

const TUTEO_RE = /\b(t[uú]|te|ti|contigo|tienes|quieres|puedes|sabes|eres|est[aá]s|vienes|haces)\b/gi;
const USTED_RE = /\b(usted|le\b|su\b|tiene|quiere|puede|sabe(?!s)|est[aá](?!s)\b|viene(?!s)|d[ií]game|disculpe)\b/gi;
const VOSEO_RE = /\b(vos|ten[eé]s|quer[eé]s|pod[eé]s|sab[eé]s|sos|and[aá]|dec[ií]me|mir[aá]\b)\b/gi;
const ES_STOP_RE = /\b(que|de|la|el|en|los|para|por|con|una|pero|como|más|este|esta|hola|gracias|bueno|entonces|también)\b/gi;
const EN_STOP_RE = /\b(the|and|for|you|that|with|this|have|what|just|about|okay|thanks|hello|because)\b/gi;
const ACCENT_RE = /[áéíóúñü]/i;
const ABBREVIATIONS = ["xq", "pq", "q", "tqm", "ntp", "tmb", "bn", "xfa", "km", "sdd", "grax", "d nada", "np", "idk", "btw", "lol"];

function detectPronounStyle(texts: string[]): StyleStats["pronounStyle"] {
  const tuteo = countMatches(texts, TUTEO_RE);
  const usted = countMatches(texts, USTED_RE);
  const voseo = countMatches(texts, VOSEO_RE);
  const max = Math.max(tuteo, usted, voseo);
  if (max < 3) return null;
  // voseo markers are rarer but far more specific, so weigh them up
  if (voseo * 3 >= max) return "voseo";
  return tuteo >= usted ? "tuteo" : "usted";
}

function detectLanguage(texts: string[]): StyleStats["language"] {
  const es = countMatches(texts, ES_STOP_RE);
  const en = countMatches(texts, EN_STOP_RE);
  if (es + en < 5) return null;
  if (es > en * 3) return "es";
  if (en > es * 3) return "en";
  return "mixed";
}

/**
 * Relationship dynamics need BOTH sides of the conversation (chronological).
 * Computed separately from style because style uses only outgoing messages.
 */
export function analyzeDynamics(allMessages: { from_me: number; timestamp: number }[], episodeGapMs = 3 * 3600_000): RelationshipDynamics | null {
  if (allMessages.length < 10) return null;
  const chrono = allMessages.slice().sort((a, b) => a.timestamp - b.timestamp);

  const replyDelays: number[] = [];
  let episodeStarts = 0;
  let episodeStartsByMe = 0;
  let bursts = 0;
  let burstMessages = 0;
  let prev: { from_me: number; timestamp: number } | null = null;

  for (const m of chrono) {
    if (!prev || m.timestamp - prev.timestamp > episodeGapMs) {
      episodeStarts++;
      if (m.from_me) episodeStartsByMe++;
    } else if (m.from_me && !prev.from_me) {
      // the user replying to the contact within the same episode
      replyDelays.push((m.timestamp - prev.timestamp) / 1000);
    }
    if (m.from_me) {
      if (prev?.from_me && m.timestamp - prev.timestamp < 3 * 60_000) {
        burstMessages++;
      } else {
        bursts++;
        burstMessages++;
      }
    }
    prev = m;
  }

  replyDelays.sort((a, b) => a - b);
  const median = replyDelays.length > 0 ? replyDelays[Math.floor(replyDelays.length / 2)]! : null;
  const spanWeeks = Math.max(1 / 7, (chrono[chrono.length - 1]!.timestamp - chrono[0]!.timestamp) / (7 * 24 * 3600_000));

  return {
    medianReplySeconds: median === null ? null : Math.round(median),
    initiationRatio: episodeStarts === 0 ? null : Number((episodeStartsByMe / episodeStarts).toFixed(2)),
    avgBurstLength: bursts === 0 ? 0 : Number((burstMessages / bursts).toFixed(1)),
    messagesPerWeek: Number((chrono.length / spanWeeks).toFixed(1)),
  };
}

/**
 * Deterministic style analysis over a set of the user's OUTGOING messages.
 * No LLM involved — this runs in milliseconds over thousands of messages,
 * which is what keeps per-contact memory cheap.
 */
export function analyzeStyle(messages: MessageRow[], dynamics: RelationshipDynamics | null = null): StyleStats {
  // Only the user's own prose shapes their voice — never our placeholders or
  // pasted code. URLs are stripped (not the whole message): "mira esto <link>"
  // is real writing, but the link's tokens are not vocabulary.
  const texts = messages
    .map((m) => (m.text ?? "").replace(URL_RE, " ").replace(/\s+/g, " ").trim())
    .filter(isAuthoredText);
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

  const withAccents = texts.filter((t) => ACCENT_RE.test(t)).length;
  const usedAbbreviations = ABBREVIATIONS.filter((abbr) =>
    texts.some((t) => new RegExp(`(?:^|\\s)${abbr}(?:\\s|$|[.,!?])`, "i").test(t))
  );

  return {
    messageCount: n,
    avgMessageLength: n === 0 ? 0 : Math.round(texts.reduce((s, t) => s + t.length, 0) / n),
    topEmojis,
    laughterStyle: bestLaugh > 0 ? laughterStyle : null,
    formality,
    formalitySignals: { formal, casual: Math.round(casual) },
    pronounStyle: detectPronounStyle(texts),
    language: detectLanguage(texts),
    tildeUsage: n === 0 ? 0 : Number((withAccents / n).toFixed(2)),
    abbreviations: usedAbbreviations,
    startsLowercaseRatio: n === 0 ? 0 : Number((startsLower / n).toFixed(2)),
    exclamationRate: n === 0 ? 0 : Number((exclamations / n).toFixed(2)),
    questionRate: n === 0 ? 0 : Number((questions / n).toFixed(2)),
    usesFinalPunctuationRatio: n === 0 ? 0 : Number((endsWithPunct / n).toFixed(2)),
    topPhrases,
    peakHours,
    dynamics,
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
  if (stats.pronounStyle) {
    const label = { tuteo: "de tú", usted: "de usted", voseo: "de vos" }[stats.pronounStyle];
    parts.push(`Trata a esta persona ${label}.`);
  }
  if (stats.language === "en") parts.push("Escribe principalmente en inglés en este chat.");
  if (stats.language === "mixed") parts.push("Mezcla español e inglés (spanglish).");
  if (stats.tildeUsage < 0.15 && stats.messageCount >= 20) parts.push("Casi nunca escribe tildes.");
  if (stats.abbreviations.length > 0) parts.push(`Abreviaciones que usa: ${stats.abbreviations.join(", ")}.`);
  if (stats.dynamics) {
    const d = stats.dynamics;
    if (d.medianReplySeconds !== null) {
      const mins = Math.round(d.medianReplySeconds / 60);
      parts.push(mins < 2 ? "Responde casi al instante." : `Suele responder en ~${mins} min.`);
    }
    if (d.initiationRatio !== null) {
      // initiationRatio = fraction of episodes started by the USER
      parts.push(
        d.initiationRatio > 0.65
          ? "El usuario suele iniciar las conversaciones."
          : d.initiationRatio < 0.35
            ? "Esta persona suele iniciar; el usuario responde."
            : "La iniciativa está equilibrada."
      );
    }
    if (d.avgBurstLength >= 2) parts.push(`Envía ~${d.avgBurstLength} mensajes seguidos por turno (mensajes cortos encadenados).`);
  }
  return parts.join(" ");
}
