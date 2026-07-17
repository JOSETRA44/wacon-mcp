import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TranscriptionConfig } from "../core/config.js";
import type { DownloadedMedia } from "./media.js";

export interface TranscriptResult {
  ok: boolean;
  text?: string;
  reason?: string;
}

/**
 * Optional layer-2 transcription. Vendor-agnostic by design:
 *  - "none"            → not configured; caller falls back to the native audio block.
 *  - "openai-compatible" → POST to any Whisper-style /audio/transcriptions endpoint
 *                          (OpenAI, Groq, a local llama.cpp/whisper server). Uses
 *                          global fetch — NO new npm dependency.
 *  - "whispercpp"      → shell out to a locally installed whisper.cpp binary the
 *                          user provides. Nothing bundled → package stays light.
 */
export async function transcribe(config: TranscriptionConfig, media: DownloadedMedia): Promise<TranscriptResult> {
  if (config.backend === "none") return { ok: false, reason: "no transcription backend configured" };
  try {
    if (config.backend === "openai-compatible") return await transcribeOpenAICompatible(config, media);
    if (config.backend === "whispercpp") return transcribeWhisperCpp(config, media);
    return { ok: false, reason: `unknown backend ${config.backend}` };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

async function transcribeOpenAICompatible(config: TranscriptionConfig, media: DownloadedMedia): Promise<TranscriptResult> {
  if (!config.endpoint) return { ok: false, reason: "missing endpoint" };
  const form = new FormData();
  const blob = new Blob([new Uint8Array(media.buffer)], { type: media.mimetype ?? "audio/ogg" });
  form.append("file", blob, "audio.ogg");
  form.append("model", config.model ?? "whisper-1");
  const res = await fetch(config.endpoint, {
    method: "POST",
    headers: config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : undefined,
    body: form,
    signal: AbortSignal.timeout((config.timeoutSeconds ?? 60) * 1000),
  });
  if (!res.ok) return { ok: false, reason: `endpoint returned ${res.status}` };
  const data = (await res.json()) as { text?: string };
  if (!data.text) return { ok: false, reason: "endpoint returned no text" };
  return { ok: true, text: data.text.trim() };
}

function transcribeWhisperCpp(config: TranscriptionConfig, media: DownloadedMedia): TranscriptResult {
  if (!config.binPath || !config.modelPath) return { ok: false, reason: "missing binPath/modelPath" };
  // whisper.cpp reads an audio file path; write to a temp file.
  const dir = mkdtempSync(join(tmpdir(), "wacon-audio-"));
  const audioPath = join(dir, "audio.ogg");
  writeFileSync(audioPath, media.buffer);
  const res = spawnSync(config.binPath, ["-m", config.modelPath, "-f", audioPath, "-otxt", "-np", "-nt"], {
    encoding: "utf8",
    timeout: (config.timeoutSeconds ?? 120) * 1000,
  });
  if (res.status !== 0) return { ok: false, reason: res.stderr?.slice(0, 200) || `whisper.cpp exited ${res.status}` };
  const text = res.stdout.trim();
  return text ? { ok: true, text } : { ok: false, reason: "whisper.cpp produced no text" };
}
