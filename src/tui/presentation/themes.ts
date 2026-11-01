import { createContext, useContext } from "react";
import { DEFAULT_PREFERENCES, type Preferences } from "../domain/preferences.js";

/**
 * Colour tokens. Components never hard-code a colour — they ask for a role
 * ("accent", "bubbleOut"), so a theme is just a different table. `undefined`
 * means "use the terminal's own colour", which is what the `terminal` preset
 * relies on to respect the user's existing terminal scheme.
 */
export interface Palette {
  bg?: string;
  panel?: string;
  header?: string;
  rowSelected?: string;
  rowOpen?: string;
  border: string;
  text?: string;
  muted: string;
  faint: string;
  accent: string;
  accentSoft: string;
  /** Text drawn ON accent-coloured fills (badges, avatars). */
  onAccent: string;
  bubbleIn?: string;
  bubbleOut?: string;
  textIn?: string;
  textOut?: string;
  metaOut: string;
  bubbleFlash?: string;
  chip?: string;
  tick: string;
  warn: string;
  error: string;
  people: string[];
}

export type PaletteToken = Exclude<keyof Palette, "people">;

export interface ThemePreset {
  name: string;
  label: string;
  palette: Palette;
}

const PEOPLE_DARK = ["#53bdeb", "#ff8a8c", "#a5b337", "#e26ab6", "#ffbc38", "#06cf9c", "#9e8ffc", "#ff7e5e"];
const PEOPLE_LIGHT = ["#027eb5", "#c4532d", "#5e7d00", "#b5006e", "#a35f00", "#008069", "#6145c9", "#c13d2a"];

export const PRESETS: ThemePreset[] = [
  {
    name: "whatsapp-oscuro",
    label: "WhatsApp oscuro",
    palette: {
      bg: "#0b141a", panel: "#111b21", header: "#202c33", rowSelected: "#2a3942", rowOpen: "#1f2c33", border: "#2f3b43",
      text: "#e9edef", muted: "#8696a0", faint: "#667781", accent: "#00a884", accentSoft: "#06cf9c", onAccent: "#0b141a",
      bubbleIn: "#202c33", bubbleOut: "#005c4b", textIn: "#e9edef", textOut: "#e9edef", metaOut: "#a9d6cc", bubbleFlash: "#2e4b57",
      chip: "#182229", tick: "#53bdeb", warn: "#f1c40f", error: "#f15c6d", people: PEOPLE_DARK,
    },
  },
  {
    name: "whatsapp-claro",
    label: "WhatsApp claro",
    palette: {
      bg: "#efeae2", panel: "#ffffff", header: "#f0f2f5", rowSelected: "#e9edef", rowOpen: "#f5f6f6", border: "#d1d7db",
      text: "#111b21", muted: "#667781", faint: "#8696a0", accent: "#00a884", accentSoft: "#008069", onAccent: "#ffffff",
      bubbleIn: "#ffffff", bubbleOut: "#d9fdd3", textIn: "#111b21", textOut: "#111b21", metaOut: "#667781", bubbleFlash: "#fff5c4",
      chip: "#ffffff", tick: "#027eb5", warn: "#a35f00", error: "#d9324a", people: PEOPLE_LIGHT,
    },
  },
  {
    name: "medianoche",
    label: "Medianoche (Dracula)",
    palette: {
      bg: "#1e1f29", panel: "#282a36", header: "#343746", rowSelected: "#44475a", rowOpen: "#303241", border: "#44475a",
      text: "#f8f8f2", muted: "#a6accd", faint: "#6272a4", accent: "#bd93f9", accentSoft: "#ff79c6", onAccent: "#1e1f29",
      bubbleIn: "#343746", bubbleOut: "#4b3a6b", textIn: "#f8f8f2", textOut: "#f8f8f2", metaOut: "#c9b8ef", bubbleFlash: "#565973",
      chip: "#303241", tick: "#8be9fd", warn: "#f1fa8c", error: "#ff5555", people: ["#8be9fd", "#ff79c6", "#50fa7b", "#ffb86c", "#f1fa8c", "#bd93f9", "#ff5555", "#6be5fd"],
    },
  },
  {
    name: "nord",
    label: "Nord",
    palette: {
      bg: "#242933", panel: "#2e3440", header: "#3b4252", rowSelected: "#434c5e", rowOpen: "#363d4a", border: "#4c566a",
      text: "#eceff4", muted: "#a3adbf", faint: "#7b8496", accent: "#88c0d0", accentSoft: "#8fbcbb", onAccent: "#2e3440",
      bubbleIn: "#3b4252", bubbleOut: "#355466", textIn: "#eceff4", textOut: "#eceff4", metaOut: "#b4cbd6", bubbleFlash: "#4c566a",
      chip: "#363d4a", tick: "#81a1c1", warn: "#ebcb8b", error: "#bf616a", people: ["#88c0d0", "#d08770", "#a3be8c", "#b48ead", "#ebcb8b", "#8fbcbb", "#81a1c1", "#bf616a"],
    },
  },
  {
    name: "solarizado",
    label: "Solarized oscuro",
    palette: {
      bg: "#002b36", panel: "#073642", header: "#0a4050", rowSelected: "#0f4b5c", rowOpen: "#083d4a", border: "#2a5560",
      text: "#eee8d5", muted: "#93a1a1", faint: "#657b83", accent: "#2aa198", accentSoft: "#859900", onAccent: "#002b36",
      bubbleIn: "#0a4050", bubbleOut: "#1d4f3a", textIn: "#eee8d5", textOut: "#eee8d5", metaOut: "#a7bfa0", bubbleFlash: "#245364",
      chip: "#083d4a", tick: "#268bd2", warn: "#b58900", error: "#dc322f", people: ["#268bd2", "#d33682", "#859900", "#cb4b16", "#b58900", "#2aa198", "#6c71c4", "#dc322f"],
    },
  },
  {
    name: "alto-contraste",
    label: "Alto contraste",
    palette: {
      bg: "#000000", panel: "#000000", header: "#1a1a1a", rowSelected: "#333333", rowOpen: "#111111", border: "#ffffff",
      text: "#ffffff", muted: "#d0d0d0", faint: "#b0b0b0", accent: "#00ff88", accentSoft: "#00ff88", onAccent: "#000000",
      bubbleIn: "#1a1a1a", bubbleOut: "#003d22", textIn: "#ffffff", textOut: "#ffffff", metaOut: "#d0d0d0", bubbleFlash: "#4d4d00",
      chip: "#000000", tick: "#00d7ff", warn: "#ffff00", error: "#ff4d4d", people: ["#00d7ff", "#ff87ff", "#87ff00", "#ffaf00", "#ffff00", "#00ff88", "#af87ff", "#ff5f5f"],
    },
  },
  {
    name: "terminal",
    label: "Colores de mi terminal",
    palette: {
      // No backgrounds at all: the user's own terminal scheme shows through.
      bg: undefined, panel: undefined, header: undefined, rowSelected: "blackBright", rowOpen: undefined, border: "gray",
      text: undefined, muted: "gray", faint: "gray", accent: "green", accentSoft: "greenBright", onAccent: "black",
      bubbleIn: undefined, bubbleOut: undefined, textIn: undefined, textOut: "greenBright", metaOut: "gray", bubbleFlash: "blackBright",
      chip: undefined, tick: "cyan", warn: "yellow", error: "red", people: ["cyan", "magenta", "yellow", "blue", "red", "green"],
    },
  },
];

export const presetByName = (name: string): ThemePreset => PRESETS.find((p) => p.name === name) ?? PRESETS[0]!;

export interface ResolvedTheme {
  name: string;
  label: string;
  c: Palette;
  prefs: Preferences;
  /** Minimal bubbles have no fill; the "terminal" preset is always minimal. */
  filled: boolean;
  compact: boolean;
}

/** Preset + user overrides + style switches → what components render with. */
export function resolveTheme(prefs: Preferences): ResolvedTheme {
  const preset = presetByName(prefs.theme);
  const c: Palette = { ...preset.palette };
  for (const [k, v] of Object.entries(prefs.colors)) {
    if (k === "people") continue;
    if (k in c) (c as unknown as Record<string, string>)[k] = v;
  }
  return {
    name: preset.name,
    label: preset.label,
    c,
    prefs,
    filled: prefs.bubbles === "filled" && preset.name !== "terminal",
    compact: prefs.density === "compact",
  };
}

const ThemeContext = createContext<ResolvedTheme>(resolveTheme(DEFAULT_PREFERENCES));
export const ThemeProvider = ThemeContext.Provider;
export const useTheme = (): ResolvedTheme => useContext(ThemeContext);

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
