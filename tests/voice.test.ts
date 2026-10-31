import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { computeWaveform, toVoiceNote, voiceNoteContent, findFfmpeg, formatDuration, VoiceNoteError, OPUS_MIME } from "../src/media/voice.js";

/** Mono 16-bit LE PCM from a generator over [0, 1). */
function pcm(samples: number, amplitudeAt: (t: number) => number): Buffer {
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const value = Math.max(-1, Math.min(1, amplitudeAt(i / samples)));
    buf.writeInt16LE(Math.round(value * 32767), i * 2);
  }
  return buf;
}

describe("computeWaveform", () => {
  it("returns exactly the 64 bars WhatsApp draws", () => {
    const wave = computeWaveform(pcm(8000, (t) => Math.sin(t * 200)));
    expect(wave.length).toBe(64);
  });

  it("keeps every bar inside 0-100 and peaks at 100", () => {
    const wave = computeWaveform(pcm(8000, (t) => Math.sin(t * 200)));
    expect(Math.min(...wave)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...wave)).toBe(100);
  });

  it("draws a flat line for digital silence instead of NaNs", () => {
    const wave = computeWaveform(pcm(8000, () => 0));
    expect([...wave]).toEqual(new Array(64).fill(0));
  });

  it("shows a fade-out as descending bars", () => {
    // Amplitude ramps down, so the last bars must be quieter than the first.
    const wave = computeWaveform(pcm(16000, (t) => (1 - t) * Math.sin(t * 400)));
    expect(wave[0]!).toBeGreaterThan(wave[63]!);
  });

  it("survives a clip shorter than one sample per bar", () => {
    const wave = computeWaveform(pcm(10, (t) => Math.sin(t * 10)));
    expect(wave.length).toBe(64);
    expect([...wave].every((v) => v >= 0 && v <= 100)).toBe(true);
  });

  it("handles an empty buffer", () => {
    expect(computeWaveform(Buffer.alloc(0)).length).toBe(64);
  });
});

describe("formatDuration", () => {
  it("formats seconds the way a chat bubble reads", () => {
    expect(formatDuration(7)).toBe("0:07");
    expect(formatDuration(83)).toBe("1:23");
    expect(formatDuration(undefined)).toBe("0:00");
  });
});

describe("voiceNoteContent", () => {
  it("always marks the message as push-to-talk opus", () => {
    const content = voiceNoteContent({ buffer: Buffer.alloc(4, 1), mimetype: OPUS_MIME, transcoded: true, seconds: 3, waveform: new Uint8Array(64) });
    expect(content.ptt).toBe(true);
    expect(content.mimetype).toBe(OPUS_MIME);
    expect(content.seconds).toBe(3);
    expect((content.waveform as Uint8Array).length).toBe(64);
  });

  it("omits what it does not know so Baileys can fill it in", () => {
    const content = voiceNoteContent({ buffer: Buffer.alloc(4, 1), mimetype: OPUS_MIME, transcoded: false });
    expect("seconds" in content).toBe(false);
    expect("waveform" in content).toBe(false);
  });
});

describe("toVoiceNote without ffmpeg", () => {
  it("passes opus straight through, flagging what was lost", () => {
    const voice = toVoiceNote(Buffer.alloc(64, 7), "audio/ogg; codecs=opus", null);
    expect(voice.transcoded).toBe(false);
    expect(voice.mimetype).toBe(OPUS_MIME);
    expect(voice.degraded).toMatch(/ffmpeg/);
    expect(voice.waveform).toBeUndefined();
  });

  it("refuses to ship an mp3 as a voice note", () => {
    // Sending it anyway would look delivered and play for nobody.
    expect(() => toVoiceNote(Buffer.alloc(64, 7), "audio/mpeg", null)).toThrow(VoiceNoteError);
  });

  it("rejects empty audio", () => {
    expect(() => toVoiceNote(Buffer.alloc(0), OPUS_MIME, null)).toThrow(/vac/);
  });
});

// The real transcode only runs where ffmpeg exists; the suite must stay green
// on machines without it, which is exactly the degradation this feature ships.
const ffmpeg = findFfmpeg();

describe.skipIf(!ffmpeg)("toVoiceNote with ffmpeg", () => {
  let dir: string;
  let wav: Buffer;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "wacon-voice-test-"));
    const wavPath = join(dir, "tone.wav");
    spawnSync(ffmpeg!, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", wavPath], {
      encoding: "buffer",
      shell: process.platform === "win32",
    });
    wav = readFileSync(wavPath);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("turns a wav into an opus voice note with duration and waveform", () => {
    const voice = toVoiceNote(wav, "audio/wav", ffmpeg);
    expect(voice.transcoded).toBe(true);
    expect(voice.mimetype).toBe(OPUS_MIME);
    expect(voice.buffer.length).toBeGreaterThan(0);
    expect(voice.seconds).toBe(2);
    expect(voice.waveform?.length).toBe(64);
    expect(voice.degraded).toBeUndefined();
  });

  it("reports a decode failure instead of sending garbage", () => {
    expect(() => toVoiceNote(Buffer.from("this is not audio"), "audio/wav", ffmpeg)).toThrow(VoiceNoteError);
  });
});
