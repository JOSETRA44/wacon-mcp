import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentHistory, AgentHistoryPort } from "../application/ports.js";

/**
 * Modo IA's memory between runs: each chat's conversation with the AI, the
 * agent sessions that can be resumed, and which agents ran out of quota.
 * Atomic write (temp + rename) — the same lesson as the session files.
 */
export class AgentHistoryFile implements AgentHistoryPort {
  private readonly file: string;

  constructor(home: string) {
    this.file = join(home, "ai-history.json");
  }

  load(): AgentHistory {
    const empty: AgentHistory = { chats: {}, sessions: {}, quota: {} };
    if (!existsSync(this.file)) return empty;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<AgentHistory>;
      return {
        chats: raw.chats && typeof raw.chats === "object" ? raw.chats : {},
        sessions: raw.sessions && typeof raw.sessions === "object" ? raw.sessions : {},
        quota: raw.quota && typeof raw.quota === "object" ? raw.quota : {},
      };
    } catch {
      return empty; // a damaged file costs the history, never the app
    }
  }

  save(h: AgentHistory): void {
    try {
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(h));
      renameSync(tmp, this.file);
    } catch {
      // full disk or similar: the next save retries
    }
  }
}
