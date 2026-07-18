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

/**
 * Build an evidence-based persona body from real stats + real message samples.
 * The blank template was useless to agents; this gives them concrete, checkable
 * facts about how the user writes. Everything is marked as auto-drafted so the
 * user knows what to correct — their hand edits are never overwritten.
 */
export function draftPersonaBody(stats: StyleStats, samples: string[]): string {
  const lines: string[] = [];
  lines.push("## Mi voz");
  lines.push("");
  lines.push("_(Borrador automático a partir de tus mensajes reales. **Corrígelo**: los agentes lo leen antes de CADA mensaje que envían en tu nombre.)_");
  lines.push("");

  lines.push(`- Tono general: **${stats.formality}**, trato de **${stats.pronounStyle ?? "tú"}**.`);
  lines.push(
    `- Mensajes **cortos**: ~${stats.avgMessageLength} caracteres de media. Prefiero varios mensajes seguidos antes que un párrafo largo.`
  );
  if (stats.laughterStyle) lines.push(`- Me río escribiendo **"${stats.laughterStyle}"** (no "jajaja" genérico si no es lo mío).`);
  lines.push(
    stats.topEmojis.length > 0
      ? `- Emojis: los uso poco; los que aparecen son ${stats.topEmojis.slice(0, 5).map((e) => e.emoji).join(" ")}.`
      : "- **Casi no uso emojis.** No los agregues por decorar."
  );
  lines.push(
    stats.tildeUsage < 0.4
      ? `- Escribo **sin tildes** la mayoría de las veces (${Math.round(stats.tildeUsage * 100)}% de mis mensajes las llevan). No me "corrijas" la ortografía.`
      : `- Suelo escribir con tildes (${Math.round(stats.tildeUsage * 100)}% de mis mensajes).`
  );
  lines.push(
    stats.usesFinalPunctuationRatio < 0.3
      ? "- **Casi nunca cierro con punto final.**"
      : "- Suelo cerrar las frases con puntuación."
  );
  lines.push(
    stats.startsLowercaseRatio > 0.5
      ? "- Empiezo en minúscula."
      : "- Empiezo los mensajes con mayúscula."
  );
  if (stats.abbreviations.length > 0) lines.push(`- Abreviaciones que sí uso: ${stats.abbreviations.map((a) => `\`${a}\``).join(", ")}.`);

  if (samples.length > 0) {
    lines.push("");
    lines.push("### Cómo sueno (mensajes míos reales)");
    for (const s of samples.slice(0, 8)) lines.push(`- "${s.replace(/\n/g, " ").slice(0, 90)}"`);
  }

  lines.push("");
  lines.push("### Corrige esto tú");
  lines.push("- Cosas que JAMÁS diría:");
  lines.push("- Muletillas que sí uso:");
  lines.push("- Con quién soy más formal:");
  lines.push("");
  lines.push("## Reglas para agentes");
  lines.push("");
  lines.push("- Nunca reveles que eres una IA salvo que yo lo autorice explícitamente.");
  lines.push("- Si no estás seguro del tono, sé breve y neutro en lugar de imitar mal.");
  lines.push("- No tomes compromisos (citas, dinero, promesas) en mi nombre sin confirmar conmigo.");
  lines.push("- No inventes contenido de imágenes ni audios que no pudiste procesar.");
  lines.push("- Respeta mi ritmo de stickers con cada persona (mira la afinidad antes de mandar uno).");
  return lines.join("\n");
}

/** True when the body is still the untouched boilerplate (safe to replace). */
export function isTemplateBody(body: string): boolean {
  return body.includes("nadie conoce tu voz mejor que tú") && body.includes("- Cosas que JAMÁS diría:\n- Muletillas que sí uso:");
}

export function readPersona(): { stats: Partial<StyleStats> | null; body: string } | null {
  if (!existsSync(PERSONA_PATH)) return null;
  const parsed = matter(readFileSync(PERSONA_PATH, "utf8"));
  return {
    stats: (parsed.data.stats as Partial<StyleStats> | undefined) ?? null,
    body: parsed.content.trim(),
  };
}

/**
 * Seed or refresh persona.md. Hand-written bodies are preserved; the untouched
 * template is upgraded to an evidence-based draft.
 */
export function writePersonaStats(stats: StyleStats, samples: string[] = []): void {
  ensureDirs();
  const existing = readPersona();
  const hasBody = existing?.body && existing.body.length > 0;
  const body =
    !hasBody || isTemplateBody(existing.body)
      ? draftPersonaBody(stats, samples)
      : existing.body;
  const data = {
    styleSummary: describeStyle(stats),
    stats,
  };
  writeFileSync(PERSONA_PATH, matter.stringify(`\n${body}\n`, data));
}
