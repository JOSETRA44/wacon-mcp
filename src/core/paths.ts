import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

/**
 * All Wacon state lives under WACON_HOME (default ~/.wacon).
 * Overridable via env var so agents/tests can use isolated homes.
 */
export const WACON_HOME = process.env.WACON_HOME ?? join(homedir(), ".wacon");

export const AUTH_DIR = join(WACON_HOME, "auth");
export const PROFILES_DIR = join(WACON_HOME, "profiles");
export const DB_PATH = join(WACON_HOME, "wacon.db");
export const PERSONA_PATH = join(WACON_HOME, "persona.md");
export const CONFIG_PATH = join(WACON_HOME, "config.json");
export const NOTEBOOKS_PATH = join(WACON_HOME, "notebooks.json");
export const DAEMON_INFO_PATH = join(WACON_HOME, "daemon.json");
export const DAEMON_LOG_PATH = join(WACON_HOME, "daemon.log");

export function ensureDirs(): void {
  for (const dir of [WACON_HOME, AUTH_DIR, PROFILES_DIR]) {
    mkdirSync(dir, { recursive: true });
  }
}
