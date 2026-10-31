import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useWaconAuthState } from "../src/core/auth-state.js";

/**
 * These cover the exact incident that cost a linked session: a disk that
 * filled up mid-write left creds.json at 0 bytes, and Baileys silently
 * replaced it with a brand-new identity.
 */
describe("wacon auth state", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wacon-auth-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const credsPath = () => join(dir, "creds.json");
  const backupPath = () => join(dir, "creds.json.bak");

  it("starts a fresh identity when there is nothing on disk, without flagging corruption", async () => {
    const auth = await useWaconAuthState(dir);
    expect(auth.restored).toBe(false);
    expect(auth.corruption).toBeNull();
    expect(auth.state.creds).toBeTruthy();
  });

  it("persists creds and keeps a backup once saved", async () => {
    const auth = await useWaconAuthState(dir);
    await auth.saveCreds();
    expect(existsSync(credsPath())).toBe(true);
    expect(existsSync(backupPath())).toBe(true);
    expect(readFileSync(credsPath(), "utf8")).toBe(readFileSync(backupPath(), "utf8"));
  });

  it("reloads the same identity across restarts", async () => {
    const first = await useWaconAuthState(dir);
    await first.saveCreds();
    const registrationId = first.state.creds.registrationId;

    const second = await useWaconAuthState(dir);
    expect(second.restored).toBe(true);
    expect(second.corruption).toBeNull();
    expect(second.state.creds.registrationId).toBe(registrationId);
  });

  it("recovers from a 0-byte creds.json instead of minting a new identity", async () => {
    const first = await useWaconAuthState(dir);
    await first.saveCreds();
    const registrationId = first.state.creds.registrationId;

    writeFileSync(credsPath(), ""); // exactly what the ENOSPC truncation produced

    const second = await useWaconAuthState(dir);
    expect(second.restored).toBe(true);
    expect(second.state.creds.registrationId).toBe(registrationId);
    expect(second.corruption).toMatch(/vacío/);
    // the primary is repaired on disk, not just in memory
    expect(readFileSync(credsPath(), "utf8").trim().length).toBeGreaterThan(0);
  });

  it("recovers from truncated JSON", async () => {
    const first = await useWaconAuthState(dir);
    await first.saveCreds();
    const registrationId = first.state.creds.registrationId;

    const good = readFileSync(credsPath(), "utf8");
    writeFileSync(credsPath(), good.slice(0, Math.floor(good.length / 2)));

    const second = await useWaconAuthState(dir);
    expect(second.restored).toBe(true);
    expect(second.state.creds.registrationId).toBe(registrationId);
    expect(second.corruption).toMatch(/JSON inválido/);
  });

  it("reports corruption when neither the primary nor a backup is usable", async () => {
    writeFileSync(credsPath(), "{ not json");
    const auth = await useWaconAuthState(dir);
    expect(auth.restored).toBe(false);
    expect(auth.corruption).toMatch(/no hay respaldo/);
  });

  it("leaves no temp files behind after writing", async () => {
    const auth = await useWaconAuthState(dir);
    await auth.saveCreds();
    await auth.saveCreds();
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
  });

  it("round-trips signal keys and deletes them when set to null", async () => {
    const auth = await useWaconAuthState(dir);
    await auth.state.keys.set({ "pre-key": { "1": { public: Buffer.from("ab"), private: Buffer.from("cd") } } } as never);
    const got = await auth.state.keys.get("pre-key", ["1"]);
    expect(got["1"]).toBeTruthy();

    await auth.state.keys.set({ "pre-key": { "1": null } } as never);
    const gone = await auth.state.keys.get("pre-key", ["1"]);
    expect(gone["1"]).toBeNull();
  });

  it("survives a damaged signal key without throwing (only creds are irreplaceable)", async () => {
    const auth = await useWaconAuthState(dir);
    writeFileSync(join(dir, "pre-key-7.json"), "{{{ broken");
    const got = await auth.state.keys.get("pre-key", ["7"]);
    expect(got["7"]).toBeNull();
  });
});
