import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * WACON_HOME is read when the module loads, so each case gets a fresh home and
 * a fresh import. Without the reset these would all share the first temp dir.
 */
async function loadDoctor(home: string) {
  process.env.WACON_HOME = home;
  vi.resetModules(); // forces paths.js to re-read WACON_HOME
  return await import("../src/core/doctor.js");
}

describe("doctor", () => {
  let home: string;
  const original = process.env.WACON_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "wacon-doctor-"));
    mkdirSync(join(home, "auth"), { recursive: true });
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (original === undefined) delete process.env.WACON_HOME;
    else process.env.WACON_HOME = original;
  });

  const creds = () => join(home, "auth", "creds.json");
  const backup = () => `${creds()}.bak`;

  it("runs offline without a daemon and still reports disk and credentials", async () => {
    const { runOfflineDoctor } = await loadDoctor(home);
    const report = runOfflineDoctor();
    const names = report.checks.map((c) => c.name);
    expect(names).toContain("Espacio en disco");
    expect(names).toContain("Credenciales de sesión");
    // Offline is never a clean bill of health — the daemon is down by definition.
    expect(report.healthy).toBe(false);
  });

  it("flags a zero-byte creds.json as a failure, not a warning", async () => {
    writeFileSync(creds(), "");
    const { runOfflineDoctor } = await loadDoctor(home);
    const check = runOfflineDoctor().checks.find((c) => c.name === "Credenciales de sesión");
    expect(check?.status).toBe("fail");
    expect(check?.detail).toMatch(/VAC/i);
  });

  it("points at the backup as the recovery route when creds are damaged", async () => {
    writeFileSync(creds(), "");
    writeFileSync(backup(), JSON.stringify({ registrationId: 42 }));
    const { runOfflineDoctor } = await loadDoctor(home);
    const check = runOfflineDoctor().checks.find((c) => c.name === "Credenciales de sesión");
    expect(check?.status).toBe("fail");
    expect(check?.fix).toMatch(/--fix/);
  });

  it("--fix restores creds from the backup and preserves the damaged copy", async () => {
    writeFileSync(creds(), "");
    writeFileSync(backup(), JSON.stringify({ registrationId: 42 }));
    const { applyFixes } = await loadDoctor(home);

    const outcomes = applyFixes();
    expect(outcomes.some((o) => o.applied && /Restaurar credenciales/.test(o.action))).toBe(true);
    expect(JSON.parse(readFileSync(creds(), "utf8"))).toEqual({ registrationId: 42 });
    expect(existsSync(`${creds()}.broken`)).toBe(true);
  });

  it("--fix never overwrites healthy credentials", async () => {
    const good = JSON.stringify({ registrationId: 7 });
    writeFileSync(creds(), good);
    writeFileSync(backup(), JSON.stringify({ registrationId: 999 }));
    const { applyFixes } = await loadDoctor(home);

    applyFixes();
    expect(readFileSync(creds(), "utf8")).toBe(good);
  });

  it("--fix clears a daemon.json whose process is gone", async () => {
    // PID 1 exists everywhere; a huge PID reliably does not.
    writeFileSync(join(home, "daemon.json"), JSON.stringify({ pid: 4_000_000_000, port: 8317, token: "x" }));
    const { applyFixes } = await loadDoctor(home);

    const outcomes = applyFixes();
    expect(outcomes.some((o) => o.applied && /daemon\.json/.test(o.action))).toBe(true);
    expect(existsSync(join(home, "daemon.json"))).toBe(false);
  });

  // These hit the checks directly: the full runDoctor() shells out to the
  // NotebookLM CLI, which costs seconds per call and proves nothing here.
  it("calls out a long-lived daemon stuck in a non-connected state", async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
    writeFileSync(join(home, "daemon.json"), JSON.stringify({ pid: process.pid, port: 8317, startedAt: twoDaysAgo }));
    const { checkDaemonProcess } = await loadDoctor(home);

    const check = checkDaemonProcess({ pid: process.pid, port: 8317 }, "logged_out");
    expect(check.status).toBe("fail");
    expect(check.detail).toMatch(/zombi/);
  });

  it("does not call a long-lived daemon a zombie while it is connected", async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
    writeFileSync(join(home, "daemon.json"), JSON.stringify({ pid: process.pid, port: 8317, startedAt: twoDaysAgo }));
    const { checkDaemonProcess } = await loadDoctor(home);

    expect(checkDaemonProcess({ pid: process.pid, port: 8317 }, "connected").status).toBe("ok");
  });

  it("notices a daemon.json pointing at a dead process", async () => {
    writeFileSync(join(home, "daemon.json"), JSON.stringify({ pid: 4_000_000_000, port: 8317 }));
    const { checkDaemonProcess } = await loadDoctor(home);

    const check = checkDaemonProcess(null, "disconnected");
    expect(check.status).toBe("warn");
    expect(check.detail).toMatch(/ya no existe/);
  });

  it("reports a runtime credential write failure as a failure", async () => {
    const { checkAuthWrites } = await loadDoctor(home);
    expect(checkAuthWrites("Disco casi lleno (3 MB libres)").status).toBe("fail");
    expect(checkAuthWrites(null).status).toBe("ok");
  });
});
