/**
 * How the user wants the app to look. Pure data + tolerant parsing: a
 * hand-edited preferences file with a typo must degrade to defaults for that
 * field, never crash the app or wipe the rest of the settings.
 */

export type BubbleStyle = "filled" | "minimal";
export type Density = "comfortable" | "compact";
export type ClockFormat = "24h" | "12h";
/** "terminal" draws photos inside the app when the terminal supports it. */
export type ImageMode = "terminal" | "system";

export interface Preferences {
  /** Preset name; unknown names fall back to the default preset when resolved. */
  theme: string;
  /** Per-token colour overrides on top of the preset, e.g. { accent: "#ff6b6b" }. */
  colors: Record<string, string>;
  bubbles: BubbleStyle;
  density: Density;
  avatars: boolean;
  clock: ClockFormat;
  images: ImageMode;
  /** Which installed AI agent the "Modo IA" panel talks to (its profile id). */
  agent: string | null;
  /** Chosen model per agent id; absent = the agent's own default. */
  agentModels: Record<string, string>;
  /** Show the agent's native reasoning in full (otherwise a folded line). */
  showThinking: boolean;
  /**
   * "full": the agent keeps its own MCP servers, skills and tools, plus
   * Wacon's — it can act on what it reads (default). "wacon": only Wacon's
   * read-only toolset — cheapest, for questions about chats.
   */
  agentPower: AgentPower;
}

export type AgentPower = "full" | "wacon";

export const DEFAULT_PREFERENCES: Preferences = {
  theme: "whatsapp-oscuro",
  colors: {},
  bubbles: "filled",
  density: "comfortable",
  avatars: true,
  clock: "24h",
  images: "terminal",
  agent: null,
  agentModels: {},
  showThinking: false,
  agentPower: "full",
};

/** Hex (#rgb / #rrggbb) or a terminal colour name like "cyan" / "blackBright". */
const COLOR_RE = /^(#[0-9a-f]{3}|#[0-9a-f]{6}|[a-z]+)$/i;
export const isColor = (v: unknown): v is string => typeof v === "string" && COLOR_RE.test(v.trim());

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;

export function sanitizePreferences(raw: unknown): Preferences {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const colors: Record<string, string> = {};
  if (r.colors && typeof r.colors === "object") {
    for (const [k, v] of Object.entries(r.colors as Record<string, unknown>)) if (isColor(v)) colors[k] = v.trim();
  }
  return {
    theme: typeof r.theme === "string" && r.theme.trim() ? r.theme.trim() : DEFAULT_PREFERENCES.theme,
    colors,
    bubbles: oneOf(r.bubbles, ["filled", "minimal"] as const, DEFAULT_PREFERENCES.bubbles),
    density: oneOf(r.density, ["comfortable", "compact"] as const, DEFAULT_PREFERENCES.density),
    avatars: typeof r.avatars === "boolean" ? r.avatars : DEFAULT_PREFERENCES.avatars,
    clock: oneOf(r.clock, ["24h", "12h"] as const, DEFAULT_PREFERENCES.clock),
    images: oneOf(r.images, ["terminal", "system"] as const, DEFAULT_PREFERENCES.images),
    agent: typeof r.agent === "string" && /^[a-z0-9-]{1,32}$/.test(r.agent) ? r.agent : null,
    agentModels: sanitizeModels(r.agentModels),
    showThinking: typeof r.showThinking === "boolean" ? r.showThinking : DEFAULT_PREFERENCES.showThinking,
    agentPower: oneOf(r.agentPower, ["full", "wacon"] as const, DEFAULT_PREFERENCES.agentPower),
  };
}

/** Step a setting forwards/backwards through its options (for ←/→ in the UI). */
export function cycle<T>(options: readonly T[], current: T, dir: 1 | -1): T {
  const i = Math.max(0, options.indexOf(current));
  return options[(i + dir + options.length) % options.length]!;
}

function sanitizeModels(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!v || typeof v !== "object") return out;
  for (const [k, m] of Object.entries(v as Record<string, unknown>)) {
    if (/^[a-z0-9-]{1,32}$/.test(k) && typeof m === "string" && /^[\w.:/@+-]{1,80}$/.test(m)) out[k] = m;
  }
  return out;
}
