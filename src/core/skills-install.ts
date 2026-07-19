import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Installs the skills bundled with Wacon into the user's agent skills folder,
 * so a fresh `npm i -g wacon` leaves the agent already knowing how to drive it.
 * All bundled skills install together — one command, no per-skill hunting.
 */

export interface SkillInstallResult {
  installed: string[];
  target: string;
  skipped: string[];
}

/** Where the bundled skills live (works from src/ and from the flat dist/ bundle). */
export function bundledSkillsDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const up of ["..", join("..", "..")]) {
    const candidate = join(here, up, "skills");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Default agent skills directory (Claude Code convention), overridable. */
export function defaultSkillsTarget(): string {
  return process.env.WACON_SKILLS_DIR ?? join(homedir(), ".claude", "skills");
}

export function listBundledSkills(): string[] {
  const dir = bundledSkillsDir();
  if (!dir) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "SKILL.md")))
    .map((e) => e.name);
}

/**
 * Copy every bundled skill into the target folder.
 * @param force overwrite existing installs (otherwise they're left untouched,
 *   so a user's local edits to a skill survive upgrades).
 */
export function installSkills(target = defaultSkillsTarget(), force = false): SkillInstallResult {
  const source = bundledSkillsDir();
  const result: SkillInstallResult = { installed: [], target, skipped: [] };
  if (!source) return result;

  mkdirSync(target, { recursive: true });
  for (const name of listBundledSkills()) {
    const dest = join(target, name);
    if (existsSync(dest) && !force) {
      result.skipped.push(name);
      continue;
    }
    cpSync(join(source, name), dest, { recursive: true });
    result.installed.push(name);
  }
  return result;
}
