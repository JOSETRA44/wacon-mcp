import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { sanitizePreferences, cycle, DEFAULT_PREFERENCES } from "../../src/tui/domain/preferences.js";
import { resolveTheme, PRESETS } from "../../src/tui/presentation/themes.js";
import { PreferencesFile } from "../../src/tui/infrastructure/preferences-file.js";
import { UltraController } from "../../src/tui/application/controller.js";
import type { ChatGateway, IncomingEvent, PreferencesPort } from "../../src/tui/application/ports.js";
import { App } from "../../src/tui/presentation/App.js";

describe("preferences", () => {
  it("a hand-edited file with typos keeps the valid fields and defaults the rest", () => {
    const p = sanitizePreferences({ theme: "nord", bubbles: "bubbly", density: "compact", avatars: "yes", colors: { accent: "#ff6b6b", text: "not a colour;" } });
    expect(p).toMatchObject({ theme: "nord", bubbles: "filled", density: "compact", avatars: true, colors: { accent: "#ff6b6b" } });
    expect(p.colors.text).toBeUndefined();
    expect(sanitizePreferences("garbage")).toEqual(DEFAULT_PREFERENCES);
    expect(cycle(["a", "b", "c"], "a", -1)).toBe("c");
  });

  it("every preset defines the tokens components need; overrides win; unknown theme falls back", () => {
    for (const p of PRESETS) for (const k of ["accent", "muted", "faint", "border", "onAccent", "tick", "error"] as const) expect(p.palette[k], `${p.name}.${k}`).toBeTruthy();
    const t = resolveTheme({ ...DEFAULT_PREFERENCES, theme: "no-existe", colors: { accent: "#123456" } });
    expect(t.name).toBe("whatsapp-oscuro");
    expect(t.c.accent).toBe("#123456");
    expect(resolveTheme({ ...DEFAULT_PREFERENCES, theme: "terminal" }).filled).toBe(false); // never paints bg
  });

  it("the file adapter round-trips and survives a corrupt file", () => {
    const dir = mkdtempSync(join(tmpdir(), "wacon-prefs-"));
    const f = new PreferencesFile(join(dir, "tui.json"));
    expect(f.load()).toEqual(DEFAULT_PREFERENCES);
    f.save({ ...DEFAULT_PREFERENCES, theme: "medianoche" });
    expect(f.load().theme).toBe("medianoche");
    expect(existsSync(join(dir, "tui.json.tmp"))).toBe(false); // temp renamed away
    writeFileSync(join(dir, "tui.json"), "{ not json");
    expect(f.load()).toEqual(DEFAULT_PREFERENCES);
  });
});

const gw = (): ChatGateway => ({
  linkState: async () => ({ state: "connected", selfName: null }), relink: async () => "connected", qr: async () => ({ state: "connected", qr: null }),
  overview: async () => [
    { jid: "a@s.whatsapp.net", is_group: 0, unread_count: 0, last_message_ts: Date.now(), display_name: "Ana", alt_jid: null, last_text: "hola", last_from_me: 0, last_type: "text", last_sender_name: null },
    { jid: "b@s.whatsapp.net", is_group: 0, unread_count: 0, last_message_ts: Date.now() - 1000, display_name: "Beto", alt_jid: null, last_text: "ok", last_from_me: 1, last_type: "text", last_sender_name: null },
  ],
  messages: async () => [], memberNames: async () => ({}), presence: async () => ({ status: "unknown", lastSeenRelative: null }),
  sendText: async () => ({ ok: true, messageId: "x" }), sendFile: async () => ({ ok: true, messageId: "y" }), markRead: async () => undefined,
  waitForMessages: () => new Promise<{ cursor: number; events: IncomingEvent[] }>(() => undefined), currentCursor: async () => 0, openMedia: async () => "", fileExists: () => true,
} as unknown as ChatGateway);
const settle = () => new Promise((r) => setTimeout(r, 60));

describe("appearance in the app", () => {
  it("changing a setting persists it and re-renders live (compact = one line per chat)", async () => {
    const saved: unknown[] = [];
    const store: PreferencesPort = { load: () => DEFAULT_PREFERENCES, save: (p) => void saved.push(p), location: () => "/x/tui.json" };
    const c = new UltraController(gw(), Date.now, store);
    const ui = render(<App controller={c} files={{ complete: () => [], exists: () => true, home: () => "/" }} />);
    await c.start();
    await settle();
    const before = (ui.lastFrame() ?? "").split("\n");
    const anaLine = before.findIndex((l) => l.includes("Ana"));
    expect(before[anaLine + 1]).toContain("hola"); // comfortable: preview on its own line

    c.setPreferences({ density: "compact" });
    await settle();
    const after = ui.lastFrame() ?? "";
    expect(after).toMatch(/Ana · hola/);
    expect(saved.at(-1)).toMatchObject({ density: "compact" });
    c.stop();
    ui.unmount();
  });

  it("Ctrl+T opens the dialog and → steps the theme", async () => {
    const c = new UltraController(gw(), Date.now, { load: () => DEFAULT_PREFERENCES, save: () => undefined, location: () => "/x/tui.json" });
    const ui = render(<App controller={c} files={{ complete: () => [], exists: () => true, home: () => "/" }} />);
    await c.start();
    await settle();
    ui.stdin.write("\x14"); // Ctrl+T
    await settle();
    expect(ui.lastFrame() ?? "").toContain("Apariencia");
    ui.stdin.write("\x1b[C"); // →
    await settle();
    expect(c.getState().prefs.theme).toBe(PRESETS[1]!.name);
    expect(ui.lastFrame() ?? "").toContain(PRESETS[1]!.label);
    c.stop();
    ui.unmount();
  });
});
