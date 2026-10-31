/**
 * WhatsApp's dark palette, so the app reads as WhatsApp at a glance. Hex
 * values degrade automatically on terminals without truecolor.
 */
export const theme = {
  bg: "#0b141a",
  panel: "#111b21",
  header: "#202c33",
  rowSelected: "#2a3942",
  rowOpen: "#1f2c33",
  border: "#2f3b43",
  text: "#e9edef",
  muted: "#8696a0",
  faint: "#667781",
  accent: "#00a884",
  accentSoft: "#06cf9c",
  bubbleIn: "#202c33",
  bubbleOut: "#005c4b",
  bubbleFlash: "#2e4b57",
  chip: "#182229",
  tick: "#53bdeb",
  warn: "#f1c40f",
  error: "#f15c6d",
  // Per-person colours for avatars and group sender names.
  people: ["#53bdeb", "#ff8a8c", "#a5b337", "#e26ab6", "#ffbc38", "#06cf9c", "#9e8ffc", "#ff7e5e"],
} as const;

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
