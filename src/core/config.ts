import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { z } from "zod";
import { CONFIG_PATH, ensureDirs } from "./paths.js";

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
