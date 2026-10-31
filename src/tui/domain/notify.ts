/**
 * When does a message for a chat you are NOT reading interrupt you with a
 * banner? The list badge always updates — this only governs the banner.
 */
export interface NotifyContext {
  isGroup: boolean;
  /** Text of the incoming message (may be empty for media). */
  text: string;
  /** The user's own name, for detecting mentions in groups. */
  selfName: string | null;
  /** Last time a banner was shown for this chat, or 0. */
  lastNotifiedAt: number;
  now: number;
}

const GROUP_COOLDOWN_MS = 60_000;
const DIRECT_COOLDOWN_MS = 4_000;

export function shouldNotify(ctx: NotifyContext): boolean {
  const since = ctx.now - ctx.lastNotifiedAt;
  if (!ctx.isGroup) return since >= DIRECT_COOLDOWN_MS;
  // A busy group would otherwise bannerise every line; a mention always gets through.
  const first = ctx.selfName?.split(" ")[0]?.toLowerCase();
  const mentioned = /@\d{5,}/.test(ctx.text) || (!!first && first.length > 2 && ctx.text.toLowerCase().includes(first));
  return mentioned || since >= GROUP_COOLDOWN_MS;
}
