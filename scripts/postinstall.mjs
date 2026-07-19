/**
 * Runs after `npm install`. Installs the bundled agent skills so Wacon is
 * immediately usable by an agent, the way a well-behaved MCP should be.
 *
 * Deliberately conservative:
 *  - never fails the install (any error is swallowed),
 *  - never overwrites a skill the user already has,
 *  - skipped entirely in CI or with WACON_SKIP_POSTINSTALL=1.
 */
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.WACON_SKIP_POSTINSTALL === "1" || process.env.CI === "true") process.exit(0);

try {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const source = join(root, "skills");
  if (!existsSync(source)) process.exit(0);

  const target = process.env.WACON_SKILLS_DIR ?? join(homedir(), ".claude", "skills");
  // Only auto-install where an agent skills folder already exists — don't
  // create agent config on a machine that isn't using one.
  if (!existsSync(dirname(target))) process.exit(0);
  mkdirSync(target, { recursive: true });

  const installed = [];
  const skipped = [];
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (!entry.isDirectory() || !existsSync(join(source, entry.name, "SKILL.md"))) continue;
    const dest = join(target, entry.name);
    if (existsSync(dest)) {
      skipped.push(entry.name);
      continue;
    }
    cpSync(join(source, entry.name), dest, { recursive: true });
    installed.push(entry.name);
  }

  if (installed.length > 0) {
    console.log(`\n  wacon: skills instaladas en ${target}\n    ${installed.join(", ")}`);
    console.log("  Tu agente ya sabe usar Wacon. Empieza con: wacon login\n");
  } else if (skipped.length > 0) {
    console.log(`\n  wacon: skills ya presentes (${skipped.join(", ")}). Para actualizarlas: wacon skills install --force\n`);
  }
} catch {
  // Never break an install over this.
}
