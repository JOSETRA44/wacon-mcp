import type { MessageRow } from "../core/store.js";
import type { FactCategory } from "../memory/facts.js";

/**
 * Rule-based (no-LLM) fact extraction. Spanish-first heuristics that pull
 * CANDIDATE facts about a contact from their own (incoming) messages. Every
 * fact is low-confidence and carries its source message id, so it reads as
 * "machine-guessed, unconfirmed" — an agent or the user confirms or forgets it.
 * This is the brute-force layer that means an agent no longer has to read each
 * chat from scratch.
 */

export interface CandidateFact {
  category: FactCategory;
  fact: string;
  confidence: number;
  sourceMsgId: string;
}

/** A rule: a regex over normalized text and how to turn a match into a fact. */
interface Rule {
  category: FactCategory;
  re: RegExp;
  /** Build the fact text from the match; return null to skip. */
  build: (m: RegExpMatchArray) => string | null;
  confidence: number;
}

const clean = (s: string) =>
  s
    .replace(/\s+/g, " ")
    .replace(/[.,;:!¡¿?]+$/, "")
    .trim();

/** Cut a captured clause at the first natural boundary so facts stay atomic. */
const clause = (s: string, maxWords = 6): string | null => {
  const cut = clean(s).split(/\s+(?:y|pero|porque|aunque|que|,)\s+/i)[0] ?? "";
  const words = clean(cut).split(/\s+/).slice(0, maxWords).join(" ");
  return words.length >= 2 ? words : null;
};

const RULES: Rule[] = [
  // fechas / cumpleaños
  {
    category: "fechas",
    re: /\bmi cumplea[nñ]os\s+(?:es\s+)?(?:el\s+)?([0-9]{1,2}\s+de\s+[a-záéíóú]+|[0-9]{1,2}[/-][0-9]{1,2})/i,
    build: (m) => `cumpleaños: ${clean(m[1]!)}`,
    confidence: 0.5,
  },
  {
    category: "fechas",
    re: /\b(?:cumplo a[nñ]os|nac[ií])\s+(?:el\s+)?([0-9]{1,2}\s+de\s+[a-záéíóú]+|[0-9]{1,2}[/-][0-9]{1,2})/i,
    build: (m) => `fecha personal: ${clean(m[1]!)}`,
    confidence: 0.4,
  },
  // ocupación / estudios
  {
    category: "ocupacion",
    re: /\btrabajo\s+(?:en|de|como)\s+([a-záéíóúñ0-9 ]{3,40})/i,
    build: (m) => clause(m[1]!) && `trabaja en/de ${clause(m[1]!)}`,
    confidence: 0.45,
  },
  {
    category: "ocupacion",
    re: /\bestudio\s+(?:en\s+)?([a-záéíóúñ0-9 ]{3,40})/i,
    build: (m) => clause(m[1]!) && `estudia ${clause(m[1]!)}`,
    confidence: 0.4,
  },
  {
    category: "ocupacion",
    re: /\bsoy\s+(ingenier[oa]|abogad[oa]|doctor[a]?|enfermer[oa]|profesor[a]?|estudiante|contador[a]?|dise[nñ]ador[a]?|programador[a]?|m[eé]dic[oa]|psic[oó]log[oa]|arquitect[oa])\b/i,
    build: (m) => `es ${clean(m[1]!).toLowerCase()}`,
    confidence: 0.5,
  },
  // lugares
  {
    category: "contexto",
    re: /\bvivo\s+en\s+([a-záéíóúñ0-9 ]{3,30})/i,
    build: (m) => clause(m[1]!, 4) && `vive en ${clause(m[1]!, 4)}`,
    confidence: 0.45,
  },
  {
    category: "contexto",
    re: /\bsoy\s+de\s+([a-záéíóúñ ]{3,25})/i,
    build: (m) => clause(m[1]!, 3) && `es de ${clause(m[1]!, 3)}`,
    confidence: 0.35,
  },
  // relación / roles (self-declared)
  {
    category: "relacion",
    re: /\bmi\s+(novi[oa]|espos[oa]|herman[oa]|mam[aá]|pap[aá]|hij[oa]|jefe|jefa|profe|profesor[a]?|amig[oa]|primo|prima)\b/i,
    build: (m) => `menciona a su ${clean(m[1]!).toLowerCase()}`,
    confidence: 0.3,
  },
  // gustos / disgustos
  {
    category: "gustos",
    re: /\b(?:me\s+encanta|me\s+gusta|amo|me\s+fascina)\s+([a-záéíóúñ0-9 ]{3,30})/i,
    build: (m) => clause(m[1]!) && `le gusta ${clause(m[1]!)}`,
    confidence: 0.4,
  },
  {
    category: "disgustos",
    re: /\b(?:odio|detesto|no\s+me\s+gusta|me\s+molesta)\s+([a-záéíóúñ0-9 ]{3,30})/i,
    build: (m) => clause(m[1]!) && `no le gusta ${clause(m[1]!)}`,
    confidence: 0.4,
  },
  // objetivos
  {
    category: "objetivos",
    re: /\b(?:quiero|voy\s+a|planeo|pienso)\s+(viajar|estudiar|trabajar|mudarme|comprar|graduarme)\s+([a-záéíóúñ0-9 ]{0,25})/i,
    build: (m) => `objetivo: ${clean(`${m[1]} ${m[2] ?? ""}`)}`,
    confidence: 0.3,
  },
];

/**
 * Extract candidate facts from a contact's INCOMING messages.
 * Dedupes by fact text; keeps the highest-confidence variant.
 */
export function extractFacts(incoming: MessageRow[]): CandidateFact[] {
  const found = new Map<string, CandidateFact>();
  for (const msg of incoming) {
    const text = msg.text;
    if (!text || text.length < 6 || text.startsWith("[")) continue; // skip placeholders
    for (const rule of RULES) {
      // Regexes carry accented char classes + the `i` flag, so match raw text.
      const m = text.match(rule.re);
      if (!m) continue;
      const factText = rule.build(m);
      if (!factText) continue;
      const key = factText.toLowerCase();
      const cand: CandidateFact = { category: rule.category, fact: factText, confidence: rule.confidence, sourceMsgId: msg.id };
      const prev = found.get(key);
      if (!prev || cand.confidence > prev.confidence) found.set(key, cand);
    }
  }
  return [...found.values()];
}

export interface CandidateActionable {
  title: string;
  whenTs: number | null;
  rawText: string;
  sourceMsgId: string;
}

const MONTHS: Record<string, number> = {
  enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5,
  julio: 6, agosto: 7, septiembre: 8, setiembre: 8, octubre: 9, noviembre: 10, diciembre: 11,
};

const ACTIONABLE_RE =
  /\b(examen|parcial|entrega|tif|plazo|fecha\s+l[ií]mite|sustitutorio|exposici[oó]n|continua|rezagado)\b/i;

/** Try to parse a concrete date near the text into a timestamp (best effort). */
function parseWhen(text: string, aroundTs: number): number | null {
  // "el 20 de julio", "lunes 20", "20/07"
  const dm = text.match(/\b([0-9]{1,2})\s+de\s+([a-záéíóú]+)/i);
  if (dm) {
    const day = Number(dm[1]);
    const month = MONTHS[dm[2]!.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")];
    if (month !== undefined && day >= 1 && day <= 31) {
      const year = new Date(aroundTs).getFullYear();
      return new Date(year, month, day, 8, 0, 0).getTime();
    }
  }
  const slash = text.match(/\b([0-9]{1,2})[/-]([0-9]{1,2})(?:[/-]([0-9]{2,4}))?\b/);
  if (slash) {
    const day = Number(slash[1]);
    const month = Number(slash[2]) - 1;
    const year = slash[3] ? Number(slash[3].length === 2 ? `20${slash[3]}` : slash[3]) : new Date(aroundTs).getFullYear();
    if (month >= 0 && month <= 11 && day >= 1 && day <= 31) return new Date(year, month, day, 8, 0, 0).getTime();
  }
  return null;
}

/**
 * Extract actionable items (deadlines, exams, deliverables) from a group's
 * recent messages. Returns SUGGESTIONS only — never touches the calendar.
 */
export function extractActionables(messages: MessageRow[], sinceDays = 45): CandidateActionable[] {
  const since = Date.now() - sinceDays * 86_400_000;
  const out: CandidateActionable[] = [];
  const seen = new Set<string>();
  for (const m of messages) {
    if (m.from_me || !m.text || m.timestamp < since) continue;
    if (!ACTIONABLE_RE.test(m.text)) continue;
    const title = clean(m.text).slice(0, 120);
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title, whenTs: parseWhen(m.text, m.timestamp), rawText: m.text.slice(0, 300), sourceMsgId: m.id });
  }
  return out;
}
