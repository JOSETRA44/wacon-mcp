import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import { PROFILES_DIR, ensureDirs } from "../core/paths.js";
import type { StyleStats } from "./analyzer.js";
import { describeStyle } from "./analyzer.js";

export interface ContactProfile {
  jid: string;
  displayName: string | null;
  stats: Partial<StyleStats> | null;
  body: string;
}

/** Sections agents are expected to maintain. */
export const PROFILE_SECTIONS = ["Dinámica", "Temas recurrentes", "Bromas internas", "Qué evitar", "Notas de agentes"] as const;
export type ProfileSection = (typeof PROFILE_SECTIONS)[number];

const DEFAULT_BODY = `## Dinámica
_(Cómo es la relación: pareja, jefe, amigo de la infancia... quién inicia, qué tan rápido se responde.)_

## Temas recurrentes
_(De qué hablan normalmente.)_

## Bromas internas
_(Apodos, referencias, chistes que solo funcionan aquí.)_

## Qué evitar
_(Temas sensibles, tonos que no encajan, errores pasados.)_

## Notas de agentes
_(Observaciones que los agentes IA agregan después de cada conversación.)_
`;

function profileFileName(jid: string): string {
  return `${jid.replace(/[@:.]/g, "_")}.md`;
}

export function profilePath(jid: string): string {
  return join(PROFILES_DIR, profileFileName(jid));
}

export function readProfile(jid: string): ContactProfile | null {
  const path = profilePath(jid);
  if (!existsSync(path)) return null;
  const parsed = matter(readFileSync(path, "utf8"));
  return {
    jid,
    displayName: (parsed.data.displayName as string | undefined) ?? null,
    stats: (parsed.data.stats as Partial<StyleStats> | undefined) ?? null,
    body: parsed.content.trim(),
  };
}

export function listProfiles(): string[] {
  ensureDirs();
  return readdirSync(PROFILES_DIR).filter((f) => f.endsWith(".md"));
}

/** Create the profile if missing, then merge the fresh stats into its frontmatter. Agent notes in the body are never touched. */
export function writeProfileStats(jid: string, displayName: string | null, stats: StyleStats): void {
  ensureDirs();
  const existing = readProfile(jid);
  const body = existing?.body && existing.body.length > 0 ? existing.body : DEFAULT_BODY.trim();
  const data = {
    jid,
    displayName: displayName ?? existing?.displayName ?? null,
    styleSummary: describeStyle(stats),
    stats,
  };
  writeFileSync(profilePath(jid), matter.stringify(`\n${body}\n`, data));
}

/** Append an observation bullet under a section, creating profile/section as needed. */
export function appendObservation(jid: string, section: ProfileSection, observation: string, displayName?: string | null): void {
  ensureDirs();
  const existing = readProfile(jid);
  let body = existing?.body && existing.body.length > 0 ? existing.body : DEFAULT_BODY.trim();

  const dateTag = new Date().toISOString().slice(0, 10);
  const bullet = `- ${observation} _(${dateTag})_`;
  const header = `## ${section}`;

  if (body.includes(header)) {
    // Insert right after the header (and after its placeholder line if present).
    const lines = body.split("\n");
    const idx = lines.findIndex((l) => l.trim() === header);
    let insertAt = idx + 1;
    while (insertAt < lines.length && (lines[insertAt]!.trim() === "" || lines[insertAt]!.trim().startsWith("_("))) {
      insertAt++;
    }
    lines.splice(insertAt, 0, bullet);
    body = lines.join("\n");
  } else {
    body = `${body}\n\n${header}\n${bullet}`;
  }

  const data: Record<string, unknown> = {
    jid,
    displayName: displayName ?? existing?.displayName ?? null,
  };
  if (existing?.stats) data.stats = existing.stats;
  writeFileSync(profilePath(jid), matter.stringify(`\n${body}\n`, data));
}
