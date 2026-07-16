import type { WaconConfig } from "./config.js";
import type { Store } from "./store.js";

export interface SendCheck {
  allowed: boolean;
  reason?: string;
  dryRun: boolean;
}

/**
 * Every outgoing message passes through here, no matter whether it came from
 * the CLI, an MCP tool, or the internal API. Protects the user's account
 * (WhatsApp bans spammy numbers) and protects contacts from runaway agents.
 */
export function checkSend(config: WaconConfig, store: Store, chatJid: string): SendCheck {
  if (config.blockedChats.includes(chatJid)) {
    return { allowed: false, dryRun: config.dryRun, reason: `Chat ${chatJid} is in blockedChats (config.json)` };
  }
  if (config.allowedChats.length > 0 && !config.allowedChats.includes(chatJid)) {
    return {
      allowed: false,
      dryRun: config.dryRun,
      reason: `allowedChats is set in config.json and ${chatJid} is not in it`,
    };
  }
  const sentLastMinute = store.recentSends(60_000);
  if (sentLastMinute >= config.sendRateLimitPerMinute) {
    return {
      allowed: false,
      dryRun: config.dryRun,
      reason: `Rate limit reached (${config.sendRateLimitPerMinute}/min). Wait before sending again.`,
    };
  }
  return { allowed: true, dryRun: config.dryRun };
}
