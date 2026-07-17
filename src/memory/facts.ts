import type { FactRow } from "../core/store.js";

/**
 * Dimension 1 of contact memory: facts ABOUT the person.
 * Deliberately separate from the interaction dynamics (the .md body) and from
 * writing style (frontmatter stats). Different purpose → different storage.
 */

export const FACT_CATEGORIES = [
  "identidad", // name, age, where they live
  "ocupacion", // job, studies
  "relacion", // how they relate to the user (partner, boss, cousin...)
  "fechas", // birthday, anniversaries, key dates
  "gustos", // likes, hobbies, music, food
  "disgustos", // dislikes, pet peeves, allergies
  "contexto", // life context: family, pets, city, projects
  "salud", // health notes worth remembering gently
  "objetivos", // goals, plans, things they're working toward
] as const;

export type FactCategory = (typeof FACT_CATEGORIES)[number];

/**
 * High-value slots. When a contact has NO fact in one of these categories,
 * it's a natural thing for an agent to learn (or ask about) — this powers the
 * "detect gaps and ask questions" behavior without any LLM cost.
 */
export const FACT_GAPS: { category: FactCategory; prompt: string }[] = [
  { category: "ocupacion", prompt: "a qué se dedica" },
  { category: "fechas", prompt: "su cumpleaños o fechas importantes" },
  { category: "relacion", prompt: "cómo se conocieron / qué son" },
  { category: "gustos", prompt: "qué le gusta (música, planes, comida)" },
  { category: "objetivos", prompt: "en qué anda / qué planea" },
];

export function normalizeCategory(input: string): FactCategory {
  const c = input
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .trim();
  return (FACT_CATEGORIES as readonly string[]).includes(c) ? (c as FactCategory) : "contexto";
}

/** Which high-value slots are still empty for this contact. */
export function factGaps(existing: FactRow[]): { category: FactCategory; prompt: string }[] {
  const known = new Set(existing.map((f) => f.category));
  return FACT_GAPS.filter((g) => !known.has(g.category));
}

/**
 * Compact, token-efficient rendering for the reply briefing: grouped by
 * category, one line each, low-confidence facts flagged. Never a wall of prose.
 */
export function renderFacts(facts: FactRow[]): string {
  if (facts.length === 0) return "(sin hechos registrados todavía)";
  const byCat = new Map<string, string[]>();
  for (const f of facts) {
    const arr = byCat.get(f.category) ?? [];
    arr.push(f.confidence < 0.5 ? `${f.fact} (?)` : f.fact);
    byCat.set(f.category, arr);
  }
  return [...byCat.entries()].map(([cat, items]) => `- ${cat}: ${items.join("; ")}`).join("\n");
}
