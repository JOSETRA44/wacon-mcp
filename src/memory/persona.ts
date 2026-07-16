import { readFileSync, writeFileSync, existsSync } from "node:fs";
import matter from "gray-matter";
import { PERSONA_PATH, ensureDirs } from "../core/paths.js";
import type { StyleStats } from "./analyzer.js";
import { describeStyle } from "./analyzer.js";

const PERSONA_TEMPLATE = `## Mi voz

_(Edita esta sección a mano — nadie conoce tu voz mejor que tú. Los agentes la leen antes de CADA mensaje que envían en tu nombre.)_

- Escribo como hablo: revisa las estadísticas de arriba y corrige lo que no encaje.
- Cosas que JAMÁS diría:
- Muletillas que sí uso:

## Reglas para agentes

- Nunca reveles que eres una IA salvo que yo lo autorice explícitamente.
- Si no estás seguro del tono, sé breve y neutro en lugar de imitar mal.
- No tomes compromisos (citas, dinero, promesas) en mi nombre sin confirmar conmigo.
`;

export function readPersona(): { stats: Partial<StyleStats> | null; body: string } | null {
  if (!existsSync(PERSONA_PATH)) return null;
  const parsed = matter(readFileSync(PERSONA_PATH, "utf8"));
  return {
    stats: (parsed.data.stats as Partial<StyleStats> | undefined) ?? null,
    body: parsed.content.trim(),
  };
}

/** Seed or refresh persona.md with global outgoing-style stats. Hand-written body is preserved. */
export function writePersonaStats(stats: StyleStats): void {
  ensureDirs();
  const existing = readPersona();
  const body = existing?.body && existing.body.length > 0 ? existing.body : PERSONA_TEMPLATE.trim();
  const data = {
    styleSummary: describeStyle(stats),
    stats,
  };
  writeFileSync(PERSONA_PATH, matter.stringify(`\n${body}\n`, data));
}
