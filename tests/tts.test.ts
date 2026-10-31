import { describe, it, expect, vi, afterEach } from "vitest";
import { synthesize } from "../src/media/tts.js";
import type { TtsConfig } from "../src/core/config.js";

function config(over: Partial<TtsConfig> = {}): TtsConfig {
  return {
    backend: "openai-compatible",
    endpoint: "https://example.test/v1/audio/speech",
    apiKey: "k",
    model: "tts-1",
    voice: "nova",
    speed: 1,
    maxChars: 1200,
    timeoutSeconds: 60,
    ...over,
  };
}

function audioResponse(bytes: Buffer, contentType = "audio/ogg") {
  return new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": contentType } });
}

afterEach(() => vi.unstubAllGlobals());

describe("synthesize", () => {
  it("returns audio from an openai-compatible endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => audioResponse(Buffer.alloc(128, 3))));
    const result = await synthesize(config(), "hola, ya voy saliendo");
    expect(result.ok).toBe(true);
    expect(result.buffer?.length).toBe(128);
    expect(result.mimetype).toBe("audio/ogg");
  });

  it("asks for opus, which is what a voice note needs", async () => {
    const fetchMock = vi.fn(async () => audioResponse(Buffer.alloc(8, 1)));
    vi.stubGlobal("fetch", fetchMock);
    await synthesize(config(), "hola");
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body.response_format).toBe("opus");
    expect(body.input).toBe("hola");
    expect(body.voice).toBe("nova");
  });

  it("reports an unconfigured backend instead of pretending", async () => {
    const result = await synthesize(config({ backend: "none" }), "hola");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no tts backend/);
  });

  it("never throws when the endpoint fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    const result = await synthesize(config(), "hola");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/500/);
  });

  it("never throws when the network dies", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    const result = await synthesize(config(), "hola");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/ECONNREFUSED/);
  });

  it("treats an empty body as a failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => audioResponse(Buffer.alloc(0))));
    const result = await synthesize(config(), "hola");
    expect(result.ok).toBe(false);
  });

  it("rejects empty text without spending a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await synthesize(config(), "   ");
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a wall of text without spending a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await synthesize(config({ maxChars: 50 }), "a".repeat(51));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/too long/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("needs an endpoint", async () => {
    const result = await synthesize(config({ endpoint: undefined }), "hola");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/endpoint/);
  });
});
