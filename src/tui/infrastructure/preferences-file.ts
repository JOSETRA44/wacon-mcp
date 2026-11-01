import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WACON_HOME, ensureDirs } from "../../core/paths.js";
import { DEFAULT_PREFERENCES, sanitizePreferences, type Preferences } from "../domain/preferences.js";
import type { PreferencesPort } from "../application/ports.js";

/**
 * ~/.wacon/tui.json — human-editable on purpose (custom colours live there).
 * Written temp-then-rename: a full disk already destroyed creds.json twice on
 * this project, and a half-written settings file would reset everyone's look.
 */
export class PreferencesFile implements PreferencesPort {
  constructor(private readonly path: string = join(WACON_HOME, "tui.json")) {}

  location(): string {
    return this.path;
  }

  load(): Preferences {
    if (!existsSync(this.path)) return DEFAULT_PREFERENCES;
    try {
      return sanitizePreferences(JSON.parse(readFileSync(this.path, "utf8")));
    } catch {
      // A typo in a hand-edited file degrades to defaults; it is never fatal.
      return DEFAULT_PREFERENCES;
    }
  }

  save(prefs: Preferences): void {
    ensureDirs();
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(prefs, null, 2)}\n`, "utf8");
    renameSync(tmp, this.path);
  }
}
