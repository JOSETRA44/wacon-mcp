import { initAuthCreds, BufferJSON, proto, type AuthenticationCreds, type AuthenticationState, type SignalDataTypeMap } from "@whiskeysockets/baileys";
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statfsSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

/**
 * Drop-in replacement for Baileys' `useMultiFileAuthState`, hardened against
 * the failure that actually cost us a session.
 *
 * Baileys writes auth files with `writeFile(path, json)`. That opens with
 * O_TRUNC: the file is emptied BEFORE the new bytes are written, so a write
 * that fails halfway — a full disk, most realistically — leaves a 0-byte
 * `creds.json` and the session is gone. Worse, its reader swallows every error
 * and falls back to `initAuthCreds()`, minting a brand-new identity in total
 * silence; the user just sees an unexplained QR prompt and assumes WhatsApp
 * unlinked them.
 *
 * Three changes close that hole:
 *  - writes go to a temp file, get fsync'd, then `rename` over the target
 *    (atomic on POSIX and Windows) — a failed write can never damage the
 *    file that is already there;
 *  - every successful creds write refreshes `creds.json.bak`, so even a
 *    catastrophic loss is recoverable without re-scanning a QR;
 *  - unreadable creds are reported instead of silently replaced.
 */

/** Bytes we insist on having spare before touching the credential file. */
const MIN_FREE_BYTES = 16 * 1024 * 1024;

export class AuthWriteError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = "AuthWriteError";
  }
}

function freeBytes(dir: string): number | null {
  try {
    const s = statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

/**
 * Write atomically: temp file → fsync → rename. The fsync matters as much as
 * the rename; without it the rename can land while the data is still in the
 * page cache, and a crash leaves an empty file with a valid name.
 */
function writeAtomic(filePath: string, contents: string): void {
  const tmp = `${filePath}.${process.pid}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "w");
    writeSync(fd, contents);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, filePath);
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // fd already gone; nothing left to release
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      // temp may not exist — the original file is intact either way
    }
    throw err;
  }
}

export interface WaconAuthState {
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  /** True when a usable session was loaded from disk (vs. a fresh identity). */
  restored: boolean;
  /** Set when creds existed but were unusable — the caller should surface it. */
  corruption: string | null;
}

/** Read + parse a credential file, distinguishing "absent" from "damaged". */
function readCredsFile(filePath: string): { creds: AuthenticationCreds | null; error: string | null } {
  if (!existsSync(filePath)) return { creds: null, error: null };
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    return { creds: null, error: `no se pudo leer: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (raw.trim().length === 0) return { creds: null, error: "archivo vacío (0 bytes)" };
  try {
    return { creds: JSON.parse(raw, BufferJSON.reviver) as AuthenticationCreds, error: null };
  } catch {
    return { creds: null, error: "JSON inválido (escritura truncada)" };
  }
}

export async function useWaconAuthState(folder: string): Promise<WaconAuthState> {
  mkdirSync(folder, { recursive: true });
  const fixName = (file: string) => file.replace(/\//g, "__").replace(/:/g, "-");
  const pathFor = (file: string) => join(folder, fixName(file));
  const credsPath = pathFor("creds.json");
  const backupPath = `${credsPath}.bak`;

  let corruption: string | null = null;
  let { creds, error } = readCredsFile(credsPath);

  // Primary is damaged or missing but a backup survives: prefer the backup over
  // silently starting a new identity. Losing a few minutes of key rotation is
  // recoverable; losing the link means re-syncing the whole history.
  if (!creds) {
    const backup = readCredsFile(backupPath);
    if (backup.creds) {
      creds = backup.creds;
      corruption = error
        ? `creds.json dañado (${error}); se restauró desde creds.json.bak`
        : "creds.json ausente; se restauró desde creds.json.bak";
      try {
        copyFileSync(backupPath, credsPath);
      } catch {
        // in-memory restore still works for this run
      }
    } else if (error) {
      corruption = `creds.json dañado (${error}) y no hay respaldo utilizable`;
    }
  }

  const restored = creds !== null;
  const activeCreds: AuthenticationCreds = creds ?? initAuthCreds();

  const writeData = (data: unknown, file: string): void => {
    const target = pathFor(file);
    const free = freeBytes(folder);
    if (free !== null && free < MIN_FREE_BYTES) {
      throw new AuthWriteError(
        `Disco casi lleno (${(free / 1024 / 1024).toFixed(0)} MB libres): no se escribe la sesión de WhatsApp para no corromperla. Libera espacio.`
      );
    }
    writeAtomic(target, JSON.stringify(data, BufferJSON.replacer));
  };

  return {
    restored,
    corruption,
    state: {
      creds: activeCreds,
      keys: {
        get: async (type, ids) => {
          const data: Record<string, unknown> = {};
          for (const id of ids) {
            const file = pathFor(`${type}-${id}.json`);
            let value: unknown = null;
            if (existsSync(file)) {
              try {
                value = JSON.parse(readFileSync(file, "utf8"), BufferJSON.reviver);
              } catch {
                // A damaged signal key is not fatal: Baileys renegotiates it.
                // Only creds.json is irreplaceable, so only that one is loud.
                value = null;
              }
            }
            if (type === "app-state-sync-key" && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value as Record<string, unknown>);
            }
            data[id] = value;
          }
          return data as { [id: string]: SignalDataTypeMap[typeof type] };
        },
        set: async (data) => {
          for (const category in data) {
            const bucket = data[category as keyof typeof data];
            for (const id in bucket) {
              const value = (bucket as Record<string, unknown>)[id];
              const file = `${category}-${id}.json`;
              if (value) {
                writeData(value, file);
              } else {
                rmSync(pathFor(file), { force: true });
              }
            }
          }
        },
      },
    },
    saveCreds: async () => {
      writeData(activeCreds, "creds.json");
      // Refresh the backup only AFTER the primary landed intact, so the backup
      // can never be the newer-but-broken copy.
      try {
        copyFileSync(credsPath, backupPath);
      } catch {
        // a missing backup degrades recovery, it does not break the session
      }
    },
  };
}
