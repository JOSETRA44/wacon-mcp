import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A video message WhatsApp renders properly carries a still frame and its
 * duration. Baileys only computes the frame when `ffmpeg` is on PATH, and never
 * when it lives at a configured path — so Wacon does it itself, with the same
 * ffmpeg the voice notes use. Best effort: a video without them still sends.
 */
export interface VideoPreview {
  jpegThumbnail?: Buffer;
  seconds?: number;
}

/** "Duration: 00:01:02.50" from ffmpeg's banner → 63 (rounded up, min 1). */
export function parseFfmpegDuration(stderr: string): number | undefined {
  const m = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderr);
  if (!m) return undefined;
  const secs = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return Number.isFinite(secs) && secs > 0 ? Math.max(1, Math.ceil(secs)) : undefined;
}

export function videoPreview(input: Buffer, extension: string, ffmpegPath: string | null): VideoPreview {
  if (!ffmpegPath) return {};
  const dir = mkdtempSync(join(tmpdir(), "wacon-video-"));
  try {
    const inPath = join(dir, `in${extension || ".mp4"}`);
    const thumbPath = join(dir, "thumb.jpg");
    writeFileSync(inPath, input);
    // One run: the banner on stderr gives the duration, the output the frame.
    const res = spawnSync(
      ffmpegPath,
      ["-hide_banner", "-y", "-ss", "0.5", "-i", inPath, "-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "6", thumbPath],
      { encoding: "buffer", timeout: 60_000, shell: process.platform === "win32" }
    );
    const seconds = parseFfmpegDuration(res.stderr?.toString("utf8") ?? "");
    const jpegThumbnail = existsSync(thumbPath) ? readFileSync(thumbPath) : undefined;
    return { ...(jpegThumbnail && jpegThumbnail.length > 0 ? { jpegThumbnail } : {}), ...(seconds ? { seconds } : {}) };
  } catch {
    return {};
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
