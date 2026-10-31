import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Outgoing voice notes.
 *
 * A voice note is NOT "an audio file with ptt: true". WhatsApp only renders the
 * real thing — the round bubble with a waveform that plays inline — when the
 * payload is **ogg/opus mono**. Handing it an mp3 with `ptt: true` produces a
 * bubble that iOS and WhatsApp Web frequently refuse to play, which is exactly
 * what `send_file --voz` did before this module existed.
 *
 * Baileys fills in some of this by itself, but only halfway: it computes
 * `seconds` (music-metadata is a real dependency) and *tries* to compute the
 * waveform via `audio-decode`, which is an OPTIONAL peer dependency we do not
 * install — so that call fails inside its own try/catch and the note ships
 * without bars, silently. We compute both here instead.
 *
 * ffmpeg is optional on purpose, like whisper.cpp for transcription: nothing is
 * bundled, the package stays light, and a missing binary degrades to a note
 * that still plays rather than to an error.
 */

export const OPUS_MIME = "audio/ogg; codecs=opus";

/** Number of bars WhatsApp draws in a voice-note bubble. */
const WAVEFORM_SAMPLES = 64;
/** Sample rate used only to measure the waveform — low on purpose, it is 64 bars. */
const PCM_RATE = 8000;

export interface VoiceNote {
  buffer: Buffer;
  mimetype: string;
  /** Exact duration. Omitted when unknown, so Baileys can work it out instead. */
  seconds?: number;
  /** 64 bytes, 0-100. Omitted when we could not decode the audio. */
  waveform?: Uint8Array;
  transcoded: boolean;
  /** What was lost and why — for the local error log, never for the chat. */
  degraded?: string;
}

/** Audio that cannot become a valid voice note. Carries a reason for the guidance layer. */
export class VoiceNoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceNoteError";
  }
}

let ffmpegCache: { key: string; value: string | null } | null = null;

/**
 * Locate ffmpeg: the configured path first, then the PATH. Cached, because this
 * runs on every voice note and a failed lookup costs a process spawn.
 */
export function findFfmpeg(configured?: string): string | null {
  const key = configured ?? "";
  if (ffmpegCache && ffmpegCache.key === key) return ffmpegCache.value;
  const candidates = configured ? [configured] : ["ffmpeg"];
  let found: string | null = null;
  for (const bin of candidates) {
    try {
      const res = spawnSync(bin, ["-version"], {
        encoding: "utf8",
        timeout: 10_000,
        shell: process.platform === "win32",
      });
      if (res.status === 0) {
        found = bin;
        break;
      }
    } catch {
      // Not there — try the next candidate.
    }
  }
  ffmpegCache = { key, value: found };
  return found;
}

/** Test seam: forget the cached lookup. */
export function resetFfmpegCache(): void {
  ffmpegCache = null;
}

/**
 * Turn mono 16-bit little-endian PCM into the 64-bar waveform WhatsApp draws.
 *
 * Deliberately the same shape as Baileys' own `getAudioWaveform`: average the
 * absolute amplitude of each block, normalise against the loudest block, scale
 * to 0-100. Peak normalisation means a whispered note still shows full-height
 * bars — that is what makes it look like every other voice note in the chat
 * rather than a flat line.
 */
export function computeWaveform(pcm: Buffer): Uint8Array {
  const total = Math.floor(pcm.length / 2);
  const waveform = new Uint8Array(WAVEFORM_SAMPLES);
  if (total === 0) return waveform;

  const blockSize = Math.floor(total / WAVEFORM_SAMPLES);
  // Shorter than one sample per bar (a very short clip): every bar reads the
  // whole clip rather than dividing by zero.
  const size = blockSize > 0 ? blockSize : total;

  const averages: number[] = [];
  for (let i = 0; i < WAVEFORM_SAMPLES; i++) {
    const start = blockSize > 0 ? blockSize * i : 0;
    let sum = 0;
    let counted = 0;
    for (let j = 0; j < size; j++) {
      const index = (start + j) * 2;
      if (index + 1 >= pcm.length) break;
      sum += Math.abs(pcm.readInt16LE(index)) / 32768;
      counted++;
    }
    averages.push(counted > 0 ? sum / counted : 0);
  }

  const peak = Math.max(...averages);
  if (peak <= 0) return waveform; // digital silence: all bars flat, no NaNs
  for (let i = 0; i < WAVEFORM_SAMPLES; i++) {
    waveform[i] = Math.min(100, Math.floor((averages[i]! / peak) * 100));
  }
  return waveform;
}

function isOpus(mimetype: string): boolean {
  return /ogg/i.test(mimetype) || /opus/i.test(mimetype);
}

function extensionFor(mimetype: string): string {
  const m = mimetype.toLowerCase();
  if (m.includes("ogg") || m.includes("opus")) return "ogg";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("wav")) return "wav";
  if (m.includes("mp4") || m.includes("m4a") || m.includes("aac")) return "m4a";
  if (m.includes("webm")) return "webm";
  return "bin";
}

/**
 * Package raw audio as a voice note.
 *
 * With ffmpeg: one pass produces both the opus payload and the PCM we measure
 * the waveform and the exact duration from. Without it: opus input still ships
 * (Baileys will work out the duration), anything else throws — sending an mp3
 * as a voice note is worse than not sending it, because it looks delivered and
 * plays for nobody.
 */
export function toVoiceNote(input: Buffer, mimetype: string, ffmpegPath: string | null): VoiceNote {
  if (input.length === 0) throw new VoiceNoteError("el audio está vacío");

  if (!ffmpegPath) {
    if (!isOpus(mimetype)) {
      throw new VoiceNoteError(
        `sin ffmpeg no puedo convertir ${mimetype} a opus, y WhatsApp no reproduce ese formato como nota de voz`
      );
    }
    return {
      buffer: input,
      mimetype: OPUS_MIME,
      transcoded: false,
      degraded: "sin ffmpeg: la nota va sin onda ni duración exacta",
    };
  }

  const dir = mkdtempSync(join(tmpdir(), "wacon-voice-"));
  try {
    const inPath = join(dir, `in.${extensionFor(mimetype)}`);
    const oggPath = join(dir, "out.ogg");
    const pcmPath = join(dir, "out.pcm");
    writeFileSync(inPath, input);

    // One decode, two outputs: the opus payload WhatsApp plays, and the raw PCM
    // we measure. `-application voip` is what gives voice notes their
    // characteristic bitrate/quality trade-off at 32k mono.
    const res = spawnSync(
      ffmpegPath,
      [
        "-y", "-hide_banner", "-loglevel", "error",
        "-i", inPath,
        "-vn", "-c:a", "libopus", "-b:a", "32k", "-ar", "48000", "-ac", "1", "-application", "voip", "-f", "ogg", oggPath,
        "-vn", "-f", "s16le", "-ac", "1", "-ar", String(PCM_RATE), pcmPath,
      ],
      { encoding: "buffer", timeout: 120_000, shell: process.platform === "win32" }
    );

    if (res.status !== 0 || !existsSync(oggPath)) {
      const stderr = res.stderr?.toString("utf8").trim() ?? "";
      throw new VoiceNoteError(`ffmpeg falló (${res.status ?? "sin código"}): ${stderr.slice(0, 200) || "sin detalle"}`);
    }

    const buffer = readFileSync(oggPath);
    if (buffer.length === 0) throw new VoiceNoteError("ffmpeg produjo un audio vacío");

    let waveform: Uint8Array | undefined;
    let seconds: number | undefined;
    if (existsSync(pcmPath)) {
      const pcm = readFileSync(pcmPath);
      waveform = computeWaveform(pcm);
      // Duration straight from the sample count — exact, and no extra dependency.
      seconds = Math.max(1, Math.round(pcm.length / 2 / PCM_RATE));
    }

    return { buffer, mimetype: OPUS_MIME, seconds, waveform, transcoded: true };
  } finally {
    // transcription.ts leaks its temp dir; this one does not.
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Shape a voice note for Baileys. `connection.sendMedia` passes these keys straight through. */
export function voiceNoteContent(voice: VoiceNote): Record<string, unknown> {
  const content: Record<string, unknown> = {
    audio: voice.buffer,
    mimetype: voice.mimetype,
    ptt: true,
  };
  // Omitted rather than zeroed: Baileys computes whatever we leave undefined.
  if (voice.seconds !== undefined) content.seconds = voice.seconds;
  if (voice.waveform !== undefined) content.waveform = voice.waveform;
  return content;
}

/** Human-readable duration for logs and the CLI: 0:07, 1:23. */
export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return "0:00";
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
