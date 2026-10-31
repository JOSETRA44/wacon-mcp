import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The dependency rule, enforced: inner layers never import outer ones.
 *   domain        → nothing but itself (and pure core constants)
 *   application   → domain
 *   infrastructure→ application ports + domain
 *   presentation  → application + domain (never infrastructure)
 * Only src/tui/index.tsx (the composition root) may see everything.
 */
const ROOT = join(__dirname, "../../src/tui");
const files = (dir: string): string[] =>
  readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? files(join(dir, d.name)) : /\.tsx?$/.test(d.name) ? [join(dir, d.name)] : []
  );
const importsOf = (file: string) => [...readFileSync(join(ROOT, file), "utf8").matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);

const rules: [layer: string, forbidden: RegExp, why: string][] = [
  ["domain", /\/(application|infrastructure|presentation)\/|^(ink|react)$|^node:|daemon/, "domain must stay pure"],
  ["application", /\/(infrastructure|presentation)\/|^(ink|react)$|^node:|daemon/, "use cases depend on ports, not adapters or UI"],
  ["presentation", /\/infrastructure\/|daemon|^node:/, "the UI talks to the controller, never to the daemon"],
];

describe("TUI clean architecture", () => {
  for (const [layer, forbidden, why] of rules) {
    it(`${layer}: ${why}`, () => {
      expect(files(layer).length).toBeGreaterThan(0);
      const offenders = files(layer).flatMap((f) => importsOf(f).filter((i) => forbidden.test(i) && !i.endsWith("core/message-types.js")).map((i) => `${f} → ${i}`));
      expect(offenders).toEqual([]);
    });
  }
});
