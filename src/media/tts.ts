import type { TtsConfig } from "../core/config.js";

export interface TtsResult {
  ok: boolean;
  buffer?: Buffer;
  mimetype?: string;
  reason?: string;
}

/**
 * Optional text-to-speech, so an agent can answer with its voice instead of
 * text. Vendor-agnostic by the same rule as transcription:
 *  - "none"              → not configured; the caller degrades to "write it out".
 *  - "openai-compatible" → POST to any /audio/speech endpoint (OpenAI, Groq, or
 *                          a local Kokoro/openedai-speech server). Uses global
 *                          fetch — NO new npm dependency.
 *
 * We ask for `response_format: "opus"`, which already returns ogg/opus — the
 * exact container a WhatsApp voice note needs. That is why the happy path works
 * even on a machine without ffmpeg; ffmpeg only adds the waveform and the exact
 * duration on top.
 *
 * Never throws: every failure comes back as `{ ok: false, reason }` so the send
 * path can turn it into guidance instead of an error.
 */
export async function synthesize(config: TtsConfig, text: string): Promise<TtsResult> {
  const input = text.trim();
  // Checked before any network call: no point spending API credit on these.
  if (input.length === 0) return { ok: false, reason: "empty text" };
  if (input.length > config.maxChars) {
    return { ok: false, reason: `text too long: ${input.length} chars (max ${config.maxChars})` };
  }
  if (config.backend === "none") return { ok: false, reason: "no tts backend configured" };

  try {
    if (config.backend === "openai-compatible") return await synthesizeOpenAICompatible(config, input);
    return { ok: false, reason: `unknown backend ${config.backend}` };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

async function synthesizeOpenAICompatible(config: TtsConfig, input: string): Promise<TtsResult> {
  if (!config.endpoint) return { ok: false, reason: "missing endpoint" };
  const res = await fetch(config.endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: config.model ?? "tts-1",
      input,
      voice: config.voice ?? "alloy",
      response_format: "opus",
      speed: config.speed,
    }),
    signal: AbortSignal.timeout(config.timeoutSeconds * 1000),
  });
  if (!res.ok) return { ok: false, reason: `endpoint returned ${res.status}` };

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length === 0) return { ok: false, reason: "endpoint returned no audio" };
  // Trust the endpoint's own content-type when it gives one: a server that
  // ignores response_format and hands back mp3 must still be handled honestly,
  // and the voice layer decides whether it can convert it.
  const mimetype = res.headers.get("content-type")?.split(";")[0]?.trim() || "audio/ogg";
  return { ok: true, buffer, mimetype };
}
