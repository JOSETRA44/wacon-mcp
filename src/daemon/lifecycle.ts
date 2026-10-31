import { readFileSync, writeFileSync, existsSync, rmSync, openSync, closeSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DAEMON_INFO_PATH, DAEMON_LOG_PATH, ensureDirs } from "../core/paths.js";

export interface DaemonInfo {
  port: number;
  token: string;
  pid: number;
  startedAt: string;
}

export function readDaemonInfo(): DaemonInfo | null {
  if (!existsSync(DAEMON_INFO_PATH)) return null;
  try {
    return JSON.parse(readFileSync(DAEMON_INFO_PATH, "utf8")) as DaemonInfo;
  } catch {
    return null;
  }
}

export function writeDaemonInfo(info: DaemonInfo): void {
  ensureDirs();
  writeFileSync(DAEMON_INFO_PATH, JSON.stringify(info, null, 2));
}

export function clearDaemonInfo(): void {
  rmSync(DAEMON_INFO_PATH, { force: true });
}

export function newToken(): string {
  return randomBytes(24).toString("hex");
}

export async function pingDaemon(info: DaemonInfo, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/health`, {
      headers: { authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Whether a process is alive (EPERM still means "exists, not ours"). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Stop the recorded daemon and wait for it to actually let go.
 *
 * SIGTERM triggers the daemon's graceful shutdown; we then poll rather than
 * assume, because returning early is what produces the EADDRINUSE crash loop
 * when a replacement is spawned into a port that is still bound.
 */
export async function stopDaemon(timeoutMs = 10_000): Promise<{ stopped: boolean; pid: number | null }> {
  const info = readDaemonInfo();
  if (!info) return { stopped: false, pid: null };
  if (!pidAlive(info.pid)) {
    clearDaemonInfo();
    return { stopped: true, pid: info.pid };
  }
  try {
    process.kill(info.pid, "SIGTERM");
  } catch {
    // already gone between the liveness check and here
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(info.pid) && !(await pingDaemon(info, 500))) {
      clearDaemonInfo();
      return { stopped: true, pid: info.pid };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return { stopped: false, pid: info.pid };
}

/**
 * Guarantee a running daemon: reuse a healthy one, otherwise spawn the
 * daemon entry (dist/daemon.js, a sibling of the CLI bundle) detached in
 * the background and wait for its health endpoint.
 */
export async function ensureDaemon(): Promise<DaemonInfo> {
  ensureDirs();
  const existing = readDaemonInfo();
  if (existing && (await pingDaemon(existing))) return existing;
  // A recorded daemon that is alive but not answering is wedged: spawning a
  // replacement would just crash on EADDRINUSE until the timeout. Clear it out
  // first so the new process gets the port.
  if (existing && pidAlive(existing.pid)) {
    await stopDaemon();
  }
  clearDaemonInfo();

  const daemonScript = fileURLToPath(new URL("./daemon.js", import.meta.url));
  // Remember where this boot's output starts, so a crash report shows only
  // what THIS attempt wrote and not a megabyte of older history.
  const logOffset = existsSync(DAEMON_LOG_PATH) ? statSync(DAEMON_LOG_PATH).size : 0;
  const logFd = openSync(DAEMON_LOG_PATH, "a");
  const child = spawn(process.execPath, [daemonScript], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
  });
  child.unref();
  closeSync(logFd); // the child holds its own handle

  // A daemon that dies at boot (e.g. a native module built for another Node
  // version) used to leave the CLI waiting the full 30s for nothing.
  let exitCode: number | null = null;
  child.on("exit", (code) => {
    exitCode = code ?? -1;
  });

  // The HTTP server comes up before the WhatsApp socket, so this is quick
  // unless a previous daemon is still releasing the port.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    if (exitCode !== null) throw new Error(describeBootCrash(exitCode, logOffset));
    const info = readDaemonInfo();
    if (info && (await pingDaemon(info))) return info;
  }
  throw new Error(`Wacon daemon failed to start within 30s. Check the log: ${DAEMON_LOG_PATH}`);
}

/** Turn a boot crash into something actionable instead of "check the log". */
function describeBootCrash(code: number, logOffset: number): string {
  let tail = "";
  try {
    tail = readFileSync(DAEMON_LOG_PATH, "utf8").slice(logOffset);
  } catch {
    // unreadable log — fall back to the generic message below
  }
  // Two shapes of the same problem: a binary built for another Node ABI, or
  // no binary at all (what a failed `npm rebuild` leaves behind).
  if (/NODE_MODULE_VERSION|ERR_DLOPEN_FAILED|Could not locate the bindings file/.test(tail)) {
    return (
      `El daemon no arrancó: el módulo nativo better-sqlite3 no sirve para tu Node (${process.version}, ABI ${process.versions.modules}).\n` +
      `Instala una versión que publique binario precompilado para node-v${process.versions.modules}-${process.platform}-${process.arch}\n` +
      `(ver https://github.com/WiseLibs/better-sqlite3/releases), o usa Node LTS (22 o 24). \`npm rebuild\` falla si esa versión aún no soporta tu Node.`
    );
  }
  if (/ENOSPC/.test(tail)) {
    return "El daemon no arrancó: el disco está lleno (ENOSPC). Libera espacio y vuelve a intentarlo.";
  }
  const lastLines = tail.trim().split(/\r?\n/).slice(-8).join("\n");
  return `El daemon terminó al arrancar (código ${code}).${lastLines ? `\n${lastLines}` : ""}\nLog completo: ${DAEMON_LOG_PATH}`;
}
