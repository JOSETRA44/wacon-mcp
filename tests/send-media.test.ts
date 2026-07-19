import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { classify, prepareMedia, toMessageContent } from "../src/media/send-media.js";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "wacon-send-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function file(name: string, bytes = 32): string {
  const p = join(dir, name);
  writeFileSync(p, Buffer.alloc(bytes, 1));
  return p;
}

describe("file kind detection", () => {
  it("routes each extension to the right WhatsApp treatment", () => {
    expect(classify("foto.JPG").kind).toBe("image");
    expect(classify("clip.mp4").kind).toBe("video");
    expect(classify("nota.ogg").kind).toBe("audio");
    expect(classify("tarea.pdf").kind).toBe("document");
    expect(classify("hoja.xlsx").kind).toBe("document");
  });

  it("falls back to document for unknown types so nothing is ever unsendable", () => {
    const r = classify("archivo.raro");
    expect(r.kind).toBe("document");
    expect(r.mimetype).toBe("application/octet-stream");
  });
});

describe("prepareMedia", () => {
  it("reads a real file with its name and size", () => {
    const m = prepareMedia(file("foto.png", 64), 10_000);
    expect(m.kind).toBe("image");
    expect(m.fileName).toBe("foto.png");
    expect(m.bytes).toBe(64);
    expect(m.buffer.length).toBe(64);
  });

  it("rejects missing, empty and oversized files with a readable reason", () => {
    expect(() => prepareMedia(join(dir, "noexiste.pdf"), 10_000)).toThrow(/no existe/);
    expect(() => prepareMedia(file("vacio.txt", 0), 10_000)).toThrow(/vacío/);
    expect(() => prepareMedia(file("grande.pdf", 500), 100)).toThrow(/demasiado grande/);
  });
});

describe("message content shaping", () => {
  it("sends images with a caption", () => {
    const content = toMessageContent(prepareMedia(file("a.jpg"), 10_000), { caption: "mira" });
    expect(content.image).toBeInstanceOf(Buffer);
    expect(content.caption).toBe("mira");
  });

  it("distinguishes a voice note from an audio file", () => {
    const media = prepareMedia(file("a.ogg"), 10_000);
    expect(toMessageContent(media, { asVoiceNote: true }).ptt).toBe(true);
    expect(toMessageContent(media).ptt).toBe(false);
  });

  it("keeps the filename on documents so the recipient sees it", () => {
    const content = toMessageContent(prepareMedia(file("informe.pdf"), 10_000), {});
    expect(content.document).toBeInstanceOf(Buffer);
    expect(content.fileName).toBe("informe.pdf");
    expect(content.mimetype).toBe("application/pdf");
  });

  it("drops an empty caption instead of sending a blank line", () => {
    expect(toMessageContent(prepareMedia(file("b.jpg"), 10_000), { caption: "   " }).caption).toBeUndefined();
  });
});
