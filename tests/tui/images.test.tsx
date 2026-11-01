import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { parseCaps } from "../../src/tui/infrastructure/terminal-probe.js";
import { SixelImages } from "../../src/tui/infrastructure/sixel-images.js";
import { UltraController } from "../../src/tui/application/controller.js";
import type { CellRect, ChatGateway, ImagePort, IncomingEvent } from "../../src/tui/application/ports.js";
import { DEFAULT_PREFERENCES } from "../../src/tui/domain/preferences.js";
import { App } from "../../src/tui/presentation/App.js";

describe("terminal capability probe", () => {
  it("reads sixel support from DA1 and the cell size from CSI 16 t", () => {
    // What Windows Terminal 1.22+ answers.
    expect(parseCaps("\x1b[6;19;9t\x1b[?61;4;6;7;14;21;22;23;24;28;32;42c")).toEqual({ sixel: true, cellWidth: 9, cellHeight: 19 });
    // A terminal without sixel, no cell-size answer.
    expect(parseCaps("\x1b[?62;22c")).toEqual({ sixel: false, cellWidth: 10, cellHeight: 20 });
    expect(parseCaps("")).toMatchObject({ sixel: false });
  });
});

/** Captures what the adapter writes to the terminal. */
class FakeOut {
  chunks: string[] = [];
  resizes = 0;
  write(s: string) {
    this.chunks.push(s);
    return true;
  }
  emit(ev: string) {
    if (ev === "resize") this.resizes++;
    return true;
  }
}

describe("sixel adapter (real sharp + real encoder)", () => {
  it("draws a fitted image at the rect, wrapped in save/restore cursor, and round-trips through a sixel decoder", async () => {
    const sharp = ((await import("sharp")) as unknown as { default: (o: unknown) => { png(): { toBuffer(): Promise<Buffer> } } }).default;
    const png = await sharp({ create: { width: 400, height: 200, channels: 3, background: { r: 0, g: 168, b: 132 } } }).png().toBuffer();
    const out = new FakeOut();
    const img = await new SixelImages({ sixel: true, cellWidth: 10, cellHeight: 20 }, out as unknown as NodeJS.WriteStream).init();
    expect(img.available).toBe(true);
    const rect: CellRect = { row: 3, col: 3, cols: 20, rows: 6 };
    await img.draw(new Uint8Array(png), rect, "#0b141a");
    const written = out.chunks.join("");
    expect(written.startsWith("\x1b7\x1b[")).toBe(true); // save cursor + move
    expect(written).toContain("\x1bP"); // sixel DCS
    expect(written.endsWith("\x1b8")).toBe(true); // restore cursor
    // The raster attributes ("Pan;Pad;Ph;Pv) are what the terminal uses to
    // place the image: it must fit 20 cells × (6-1) rows of 10×20 px, keeping
    // the 2:1 aspect. (The library's decoder reports a slightly larger canvas,
    // so the spec-defined header is the stricter thing to check.)
    const raster = /"1;1;(\d+);(\d+)/.exec(written);
    expect(raster).not.toBeNull();
    const [w, h] = [Number(raster![1]), Number(raster![2])];
    expect(w).toBeLessThanOrEqual(200);
    expect(h).toBeLessThanOrEqual(100);
    expect(w / h).toBeCloseTo(2, 1);
    // And it is valid sixel: the reference decoder accepts it.
    const { decode } = (await import("sixel")) as unknown as { decode(d: Uint8Array): { width: number } };
    const dcs = written.slice(written.indexOf("\x1bP"), written.lastIndexOf("\x1b8"));
    expect(decode(new Uint8Array(Buffer.from(dcs, "latin1"))).width).toBeGreaterThan(150);
    img.release();
    expect(out.resizes).toBe(1);
  });

  it("stays unavailable when the terminal has no sixel", async () => {
    const img = await new SixelImages({ sixel: false, cellWidth: 10, cellHeight: 20 }).init();
    expect(img.available).toBe(false);
  });
});

describe("in-app photo viewer", () => {
  const now = Date.now();
  const gw = (opened: string[]): ChatGateway =>
    ({
      linkState: async () => ({ state: "connected", selfName: null }), relink: async () => "connected", qr: async () => ({ state: "connected", qr: null }),
      overview: async () => [{ jid: "a@s.whatsapp.net", is_group: 0, unread_count: 0, last_message_ts: now, display_name: "Ana", alt_jid: null, last_text: "", last_from_me: 0, last_type: "image", last_sender_name: null }],
      messages: async () => [
        { id: "p1", chat_jid: "a@s.whatsapp.net", sender_jid: "a@s.whatsapp.net", from_me: 0, timestamp: now - 2000, text: "[imagen: uno]", message_type: "image" },
        { id: "p2", chat_jid: "a@s.whatsapp.net", sender_jid: "a@s.whatsapp.net", from_me: 0, timestamp: now - 1000, text: "[imagen: dos]", message_type: "image" },
      ],
      memberNames: async () => ({}), presence: async () => ({ status: "unknown", lastSeenRelative: null }),
      fetchMedia: async (_j: string, id: string) => ({ data: new TextEncoder().encode(id), mimetype: "image/png" }),
      openMedia: async (_j: string, id: string) => (opened.push(id), "abierto"),
      messagesByIds: async () => [], reactions: async () => [], react: async () => ({ ok: true, messageId: "r" }),
      markRead: async () => undefined, waitForMessages: () => new Promise<{ cursor: number; events: IncomingEvent[] }>(() => undefined), currentCursor: async () => 0,
      sendText: async () => ({ ok: true, messageId: "t" }), sendFile: async () => ({ ok: true, messageId: "f" }), fileExists: () => true,
      search: async () => [], stickerMoods: async () => [], stickers: async () => [], sendSticker: async () => ({ ok: true, messageId: "s" }), sendVoice: async () => ({ ok: true, messageId: "v" }),
    }) as unknown as ChatGateway;
  const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));
  // Wait for a condition, not for a guess at how long the machine needs.
  const until = async (cond: () => boolean, timeoutMs = 4000) => {
    const end = Date.now() + timeoutMs;
    while (!cond()) {
      if (Date.now() > end) throw new Error("condition not met in time");
      await settle(20);
    }
  };
  const ENTER = String.fromCharCode(13);

  async function openViewer(images: ImagePort, prefs = DEFAULT_PREFERENCES, opened: string[] = []) {
    const c = new UltraController(gw(opened), Date.now, { load: () => prefs, save: () => undefined, location: () => "x" });
    const ui = render(<App controller={c} files={{ complete: () => [], exists: () => true, home: () => "/" }} images={images} />);
    await c.start();
    await settle();
    ui.stdin.write(ENTER); // open chat
    await settle();
    ui.stdin.write("\x1b[A"); // select last message (p2)
    await settle();
    ui.stdin.write("o"); // open attachment
    await settle(200);
    return { c, ui };
  }

  it("draws the photo, ← goes to the previous one, Esc releases the pixels", async () => {
    const drawn: string[] = [];
    let released = 0;
    const images: ImagePort = { available: true, draw: async (d) => void drawn.push(new TextDecoder().decode(d)), release: () => void released++ };
    const { c, ui } = await openViewer(images);
    await until(() => drawn.length === 1);
    expect(ui.lastFrame() ?? "").toContain("2/2");
    expect(drawn).toEqual(["p2"]);
    ui.stdin.write("\x1b[D"); // ←
    await until(() => drawn.length === 2);
    expect(drawn).toEqual(["p2", "p1"]);
    expect(ui.lastFrame() ?? "").toContain("1/2");
    ui.stdin.write("\x1b");
    await settle();
    expect(released).toBeGreaterThan(0);
    expect(ui.lastFrame() ?? "").not.toContain("1/2");
    c.stop();
    ui.unmount();
  });

  it("falls back to the system viewer when the terminal can't draw, or when the user prefers it", async () => {
    const none: ImagePort = { available: false, draw: async () => undefined, release: () => undefined };
    const opened: string[] = [];
    const a = await openViewer(none, DEFAULT_PREFERENCES, opened);
    await until(() => opened.length === 1);
    expect(opened).toEqual(["p2"]);
    a.c.stop();
    a.ui.unmount();

    const drawn: string[] = [];
    const capable: ImagePort = { available: true, draw: async (d) => void drawn.push(new TextDecoder().decode(d)), release: () => undefined };
    const opened2: string[] = [];
    const b = await openViewer(capable, { ...DEFAULT_PREFERENCES, images: "system" }, opened2);
    await until(() => opened2.length === 1);
    expect(drawn).toEqual([]);
    expect(opened2).toEqual(["p2"]);
    b.c.stop();
    b.ui.unmount();
  });
});
