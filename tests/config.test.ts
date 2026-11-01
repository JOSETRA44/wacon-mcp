import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("configuration defaults", () => {
  let home: string;
  let loadConfig: typeof import("../src/core/config.js").loadConfig;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "wacon-config-"));
    vi.stubEnv("WACON_HOME", home);
    vi.resetModules();
    ({ loadConfig } = await import("../src/core/config.js"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  function expectMediaDefaults(config: ReturnType<typeof loadConfig>) {
    expect(config.transcription).toEqual({ backend: "none", timeoutSeconds: 60 });
    expect(config.vision).toEqual({ backend: "none", timeoutSeconds: 60 });
    expect(config.tts).toEqual({
      backend: "none",
      speed: 1,
      maxChars: 1200,
      timeoutSeconds: 60,
    });
  }

  it("creates a complete configuration when the file does not exist", () => {
    const config = loadConfig();
    expectMediaDefaults(config);
    expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8"))).toEqual(config);
  });

  it("fills nested defaults when an existing configuration is empty", () => {
    writeFileSync(join(home, "config.json"), "{}");
    expectMediaDefaults(loadConfig());
  });

  it("preserves partial TTS settings while filling the missing defaults", () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({
      tts: { backend: "openai-compatible", endpoint: "http://localhost:8000/audio/speech", voice: "test-voice" },
    }));
    const config = loadConfig();
    expect(config.tts).toEqual({
      backend: "openai-compatible",
      endpoint: "http://localhost:8000/audio/speech",
      voice: "test-voice",
      speed: 1,
      maxChars: 1200,
      timeoutSeconds: 60,
    });
    expect(config.transcription).toEqual({ backend: "none", timeoutSeconds: 60 });
    expect(config.vision).toEqual({ backend: "none", timeoutSeconds: 60 });
  });

  it.each([
    ["malformed JSON", "{not json"],
    ["invalid settings", JSON.stringify({ tts: { speed: 100 } })],
  ])("returns complete defaults for %s without overwriting the file", (_label, contents) => {
    const path = join(home, "config.json");
    writeFileSync(path, contents);
    expectMediaDefaults(loadConfig());
    expect(readFileSync(path, "utf8")).toBe(contents);
  });
});
