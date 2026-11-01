import type { CellRect, ImagePort } from "../application/ports.js";
import type { TerminalCaps } from "./terminal-probe.js";

type SharpFn = (input: Buffer, opts?: { animated?: boolean }) => {
  rotate(): ReturnType<SharpFn>;
  resize(o: { width: number; height: number; fit: "inside"; withoutEnlargement: boolean }): ReturnType<SharpFn>;
  flatten(o: { background: string }): ReturnType<SharpFn>;
  ensureAlpha(): ReturnType<SharpFn>;
  raw(): ReturnType<SharpFn>;
  toBuffer(o: { resolveWithObject: true }): Promise<{ data: Buffer; info: { width: number; height: number } }>;
};
type SixelLib = { image2sixel(data: Uint8Array, width: number, height: number, maxColors?: number, backgroundSelect?: 0 | 1 | 2): string };

/**
 * ImagePort over sixel. `sharp` decodes JPEG/PNG/WebP and resizes; `sixel`
 * encodes. Both load lazily and `sharp` is an optional dependency: if either
 * is missing, `available` stays false and the app keeps using the OS viewer.
 *
 * Drawing goes straight to stdout, wrapped in save/restore cursor so Ink's
 * idea of where the cursor is stays true.
 */
export class SixelImages implements ImagePort {
  available = false;
  private libs: { sharp: SharpFn; sixel: SixelLib } | null = null;

  constructor(
    private readonly caps: TerminalCaps,
    private readonly out: NodeJS.WriteStream = process.stdout
  ) {}

  /** Resolve the optional libraries; call once at startup. */
  async init(): Promise<this> {
    if (!this.caps.sixel) return this;
    try {
      const sharpMod = (await import("sharp")) as unknown as { default?: SharpFn } & SharpFn;
      const sixel = (await import("sixel")) as unknown as SixelLib;
      this.libs = { sharp: sharpMod.default ?? sharpMod, sixel };
      this.available = true;
    } catch {
      this.available = false;
    }
    return this;
  }

  async draw(data: Uint8Array, rect: CellRect, background = "#000000"): Promise<void> {
    if (!this.libs || rect.cols < 4 || rect.rows < 2) return;
    const { sharp, sixel } = this.libs;
    const maxW = rect.cols * this.caps.cellWidth;
    // One row of slack: a sixel that touches the last row can scroll the screen.
    const maxH = (rect.rows - 1) * this.caps.cellHeight;
    const { data: rgba, info } = await sharp(Buffer.from(data), { animated: false })
      .rotate() // honour the EXIF orientation of phone photos
      .resize({ width: maxW, height: maxH, fit: "inside", withoutEnlargement: true })
      .flatten({ background })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const encoded = sixel.image2sixel(new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.length), info.width, info.height, 256, 1);
    const usedCols = Math.ceil(info.width / this.caps.cellWidth);
    const usedRows = Math.ceil(info.height / this.caps.cellHeight);
    const row = rect.row + Math.max(0, Math.floor((rect.rows - 1 - usedRows) / 2));
    const col = rect.col + Math.max(0, Math.floor((rect.cols - usedCols) / 2));
    this.out.write(`\x1b7\x1b[${row};${col}H${encoded}\x1b8`);
  }

  /**
   * Sixel pixels stay until text is drawn over them. A resize event makes Ink
   * repaint every line, which wipes the image cleanly.
   */
  release(): void {
    if (this.available) this.out.emit("resize");
  }
}

