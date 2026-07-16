import { readFileSync, writeFileSync, existsSync, rmSync, openSync } from "node:fs";
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

/**
 * Guarantee a running daemon: reuse a healthy one, otherwise spawn the
 * daemon entry (dist/daemon.js, a sibling of the CLI bundle) detached in
 * the background and wait for its health endpoint.
 */
export async function ensureDaemon(): Promise<DaemonInfo> {
  ensureDirs();
  const existing = readDaemonInfo();
  if (existing && (await pingDaemon(existing))) return existing;
  clearDaemonInfo();

  const daemonScript = fileURLToPath(new URL("./daemon.js", import.meta.url));
  const logFd = openSync(DAEMON_LOG_PATH, "a");
  const child = spawn(process.execPath, [daemonScript], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
  });
  child.unref();

  // The HTTP server comes up before the WhatsApp socket, so this is quick
  // unless a previous daemon is still releasing the port.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    const info = readDaemonInfo();
    if (info && (await pingDaemon(info))) return info;
  }
  throw new Error(`Wacon daemon failed to start within 15s. Check the log: ${DAEMON_LOG_PATH}`);
}
