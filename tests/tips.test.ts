import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// tips.ts resolves its storage from WACON_HOME at import time, so point that at
// a scratch dir before importing.
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "wacon-tips-"));
  process.env.WACON_HOME = home;
  vi.resetModules(); // paths.ts reads WACON_HOME at import time
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.WACON_HOME;
});

describe("progressive tips", () => {
  it("shows each tip once and never repeats it", async () => {
    const { nextTip, CHAT_TIPS } = await import("../src/cli/tips.js");

    const first = nextTip();
    const second = nextTip();
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first).not.toBe(second);

    // Drain the pool; every tip should be distinct.
    const seen = new Set([first, second]);
    for (let i = 0; i < CHAT_TIPS.length; i++) {
      const t = nextTip();
      if (t === null) break;
      expect(seen.has(t)).toBe(false);
      seen.add(t);
    }
    // Once exhausted it goes quiet instead of nagging.
    expect(nextTip()).toBeNull();
  });

  it("teaches the way out first — that's what newcomers get stuck on", async () => {
    const { nextTip } = await import("../src/cli/tips.js");
    expect(nextTip()).toContain("Esc");
  });

  it("persists across sessions", async () => {
    const mod = await import("../src/cli/tips.js");
    mod.nextTip();
    expect(existsSync(join(home, "tips-seen.json"))).toBe(true);
  });

  it("tipById can force a specific lesson on demand", async () => {
    const { tipById } = await import("../src/cli/tips.js");
    expect(tipById("send")).toContain("/send");
    expect(tipById("noexiste")).toBeNull();
  });
});
