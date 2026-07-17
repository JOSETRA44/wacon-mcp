import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { z } from "zod";
import { CONFIG_PATH, ensureDirs } from "./paths.js";

const TranscriptionSchema = z.object({
  /** none = fall back to native MCP audio block (zero-dep, works for multimodal agents). */
  backend: z.enum(["none", "openai-compatible", "whispercpp"]).default("none"),
  endpoint: z.string().optional(), // openai-compatible /audio/transcriptions URL
  apiKey: z.string().optional(),
  model: z.string().optional(),
  binPath: z.string().optional(), // whisper.cpp binary
  modelPath: z.string().optional(), // whisper.cpp model file
  timeoutSeconds: z.number().int().min(5).max(300).default(60),
});

const VisionSchema = z.object({
  /** none = return the native MCP image block for the agent's own vision. */
  backend: z.enum(["none", "openai-compatible"]).default("none"),
  endpoint: z.string().optional(),
  apiKey: z.string().optional(),
  model: z.string().optional(),
  timeoutSeconds: z.number().int().min(5).max(300).default(60),
});

export type TranscriptionConfig = z.infer<typeof TranscriptionSchema>;
export type VisionConfig = z.infer<typeof VisionSchema>;

const ConfigSchema = z.object({
  /** Simulation mode: sends are logged to sent_log but never hit WhatsApp. */
  dryRun: z.boolean().default(false),
  /** Max outgoing messages per minute (protects against bans and runaway agents). */
  sendRateLimitPerMinute: z.number().int().min(1).max(60).default(10),
  /** If non-empty, sends are ONLY allowed to these JIDs. */
  allowedChats: z.array(z.string()).default([]),
  /** Sends to these JIDs are always rejected. */
  blockedChats: z.array(z.string()).default([]),
  /** Port for the local daemon. */
  daemonPort: z.number().int().default(8317),
  /** Max media size (bytes) Wacon will download and hand to an agent. */
  maxMediaBytes: z.number().int().default(16 * 1024 * 1024),
  /** Optional layer-2 audio transcription (default: native audio block). */
  transcription: TranscriptionSchema.default({}),
  /** Optional layer-2 image description (default: native image block). */
  vision: VisionSchema.default({}),
  /** How often the proactive engine checks for due events (seconds). */
  proactivePollSeconds: z.number().int().min(15).max(600).default(45),
});

export type WaconConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(): WaconConfig {
  ensureDirs();
  if (!existsSync(CONFIG_PATH)) {
    const defaults = ConfigSchema.parse({});
    writeFileSync(CONFIG_PATH, JSON.stringify(defaults, null, 2));
    return defaults;
  }
  try {
    return ConfigSchema.parse(JSON.parse(readFileSync(CONFIG_PATH, "utf8")));
  } catch {
    // Corrupt or outdated config: fall back to defaults without overwriting the file,
    // so the user can fix it by hand.
    return ConfigSchema.parse({});
  }
}
