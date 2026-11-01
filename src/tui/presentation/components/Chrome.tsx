import { Box, Text, useAnimation } from "ink";
import type { Banner, Notice, UltraState } from "../../application/controller.js";
import { cells, padCells, truncate } from "../../domain/text.js";
import { PRESETS, presetByName, useTheme } from "../themes.js";
import { cycle, type Preferences } from "../../domain/preferences.js";
import { Spinner } from "./Spinner.js";

/**
 * The footer, Claude-Code style: connection health and work-in-progress on
 * the left, the keys that matter RIGHT NOW on the right. Hints change with
 * focus so the screen always tells you what you can do next.
 */
export function StatusBar({ link, busy, notice, hints, width, warning = null }: { link: UltraState["link"]; busy: string | null; notice: Notice | null; hints: string; width: number; warning?: string | null }) {
  const theme = useTheme().c;
  const live = link.phase === "ready";
  const { frame } = useAnimation({ interval: 500, isActive: !live });
  const dot = warning ? theme.error : live ? theme.accent : frame % 2 ? theme.warn : theme.faint;
  const toneColor = notice?.tone === "error" ? theme.error : notice?.tone === "success" ? theme.accentSoft : theme.text;
  // A health warning outlives transient notices: it stays until it is fixed.
  const leftText = busy ? ` ${busy}…` : notice ? ` ${notice.text}` : warning ? ` ${warning}` : live ? " conectado" : ` ${link.state ?? "conectando"}`;
  const hintW = Math.min(cells(hints), Math.max(0, width - 24));
  const leftW = width - hintW - 4;
  return (
    <Box height={1} width={width} backgroundColor={theme.header}>
      <Text backgroundColor={theme.header} color={dot}>{" ●"}</Text>
      {busy ? (
        <Text backgroundColor={theme.header}>
          {" "}
          <Spinner color={theme.accent} />
        </Text>
      ) : null}
      <Text backgroundColor={theme.header} color={busy ? theme.text : notice ? toneColor : warning ? theme.error : theme.muted}>
        {padCells(truncate(leftText, leftW - (busy ? 2 : 0)), leftW - (busy ? 2 : 0))}
      </Text>
      <Text backgroundColor={theme.header} color={theme.faint}>{truncate(hints, hintW)} </Text>
    </Box>
  );
}

/** Top-right banner for a message in a chat you are not reading. */
export function BannerToast({ banner, width }: { banner: Banner; width: number }) {
  const theme = useTheme().c;
  const w = Math.min(46, width - 4);
  return (
    <Box position="absolute" top={1} left={width - w - 2} width={w} flexDirection="column" borderStyle="round" borderColor={theme.accent} backgroundColor={theme.header} paddingX={1}>
      <Text color={theme.accentSoft} bold>{truncate(`💬 ${banner.title}`, w - 4)}</Text>
      <Text color={theme.text}>{truncate(banner.text.replace(/\s+/g, " "), w - 4)}</Text>
      <Text color={theme.faint}>Ctrl+G abrir · se oculta solo</Text>
    </Box>
  );
}

export interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
  kind: "chat" | "action";
}

/** Ctrl+K: one box to jump to any chat or run any action (opencode-style). */
export function Palette({ query, items, index, width, height }: { query: string; items: PaletteItem[]; index: number; width: number; height: number }) {
  const theme = useTheme().c;
  const w = Math.min(70, width - 6);
  const max = Math.max(3, Math.min(12, height - 8));
  const start = Math.max(0, Math.min(index - Math.floor(max / 2), items.length - max));
  const shown = items.slice(start, start + max);
  return (
    <Box position="absolute" top={2} left={Math.floor((width - w) / 2)} width={w} flexDirection="column" borderStyle="round" borderColor={theme.accent} backgroundColor={theme.panel} paddingX={1}>
      <Text color={theme.text}>
        <Text color={theme.accentSoft}>❯ </Text>
        {query}
        <Text inverse> </Text>
        {query ? "" : <Text color={theme.faint}> busca un chat o una acción</Text>}
      </Text>
      <Text color={theme.border}>{"─".repeat(w - 4)}</Text>
      {shown.length === 0 ? <Text color={theme.muted}>Sin resultados</Text> : null}
      {shown.map((it, i) => {
        const active = start + i === index;
        const bg = active ? theme.rowSelected : theme.panel;
        const label = `${it.kind === "action" ? "⚡ " : "  "}${it.label}`;
        const hint = it.hint ?? "";
        return (
          <Box key={it.id}>
            <Text backgroundColor={bg} color={active ? theme.text : theme.muted} bold={active}>
              {padCells(truncate(label, w - 6 - cells(hint)), w - 5 - cells(hint))}
            </Text>
            <Text backgroundColor={bg} color={theme.faint}>{hint}</Text>
          </Box>
        );
      })}
      <Text color={theme.faint}>↑↓ elegir · ↵ ir · Esc cerrar</Text>
    </Box>
  );
}

const HELP: [string, [string, string][]][] = [
  ["Moverte", [["↑ ↓", "elegir chat"], ["↵", "abrir chat"], ["escribe", "filtra la lista al instante"], ["Ctrl+N / Ctrl+P", "chat siguiente / anterior"], ["Ctrl+K", "saltar a cualquier chat o acción"], ["Esc", "volver a la lista"]]],
  ["Escribir", [["↵", "enviar"], ["Shift+↵ · Alt+↵ · Ctrl+J", "nueva línea"], ["Ctrl+O", "adjuntar archivo"], ["arrastrar archivo", "lo adjunta (con comentario)"], ["Ctrl+R", "reintentar envío fallido"], ["Ctrl+S · /sticker risa", "enviar sticker"], ["/voz hola", "enviarlo como nota de voz"], ["Ctrl+W · Ctrl+U", "borrar palabra · línea"]]],
  ["Mensajes", [["↑ (compositor vacío)", "elegir mensajes"], ["↵ sobre foto/audio", "abrirlo"], ["RePág / AvPág", "desplazar · carga anteriores"], ["Ctrl+F", "buscar en la conversación"], ["Alt+I", "lo que Wacon sabe de este chat"], ["Ctrl+G", "abrir el chat del aviso"]]],
  ["Modo IA", [["Ctrl+A · Tab en inicio", "preguntar a tu agente (Claude, Codex…)"], ["1-6 en inicio", "resumen de hoy, pendientes, fechas…"], ["Ctrl+L", "cambiar de agente o modelo"], ["Alt+T", "ver u ocultar su pensamiento"], ["/ en el panel", "resumir, sugerir respuesta, recordar…"], ["a sobre un mensaje", "preguntar sobre ese mensaje"], ["↵ · Tab (borrador)", "enviarlo · pasarlo al compositor"]]],
  ["App", [["Ctrl+T", "tema, burbujas, densidad, hora"], ["F1 · ?", "esta ayuda"], ["Ctrl+C ×2", "salir"]]],
];

export function HelpOverlay({ width, height }: { width: number; height: number }) {
  const theme = useTheme().c;
  const w = Math.min(64, width - 4);
  return (
    <Box position="absolute" top={Math.max(0, Math.floor((height - 30) / 2))} left={Math.floor((width - w) / 2)} width={w} flexDirection="column" borderStyle="round" borderColor={theme.accent} backgroundColor={theme.panel} paddingX={2} paddingY={1}>
      <Text color={theme.text} bold>Wacon · WhatsApp en tu terminal</Text>
      {HELP.map(([title, rows]) => (
        <Box key={title} flexDirection="column" marginTop={1}>
          <Text color={theme.accentSoft} bold>{title}</Text>
          {rows.map(([k, v]) => (
            <Text key={k}>
              <Text color={theme.text}>{padCells(`  ${k}`, 28)}</Text>
              <Text color={theme.muted}>{v}</Text>
            </Text>
          ))}
        </Box>
      ))}
      <Box marginTop={1}>
        <Text color={theme.faint}>Esc o ↵ para cerrar</Text>
      </Box>
    </Box>
  );
}

/** Ctrl+O: type or drop a path; Tab completes like a shell. */
export function AttachDialog({ value, suggestions, error, width }: { value: string; suggestions: string[]; error: string | null; width: number }) {
  const theme = useTheme().c;
  const w = Math.min(80, width - 4);
  return (
    <Box position="absolute" top={3} left={Math.floor((width - w) / 2)} width={w} flexDirection="column" borderStyle="round" borderColor={theme.accent} backgroundColor={theme.panel} paddingX={1}>
      <Text color={theme.text} bold>📎 Adjuntar archivo</Text>
      <Text color={theme.muted}>Arrastra el archivo a esta ventana, o escribe la ruta (Tab completa).</Text>
      <Box borderStyle="round" borderColor={theme.border} paddingX={1} marginTop={1}>
        <Text color={theme.text} wrap="truncate-start">
          {value}
          <Text inverse> </Text>
        </Text>
      </Box>
      {suggestions.slice(0, 6).map((s) => (
        <Text key={s} color={theme.faint}>{`  ${truncate(s, w - 6)}`}</Text>
      ))}
      {error ? <Text color={theme.error}>{error}</Text> : null}
      <Text color={theme.faint}>↵ adjuntar · Tab completar · Esc cancelar</Text>
    </Box>
  );
}

interface AppearanceRow {
  label: string;
  value: (p: Preferences) => string;
  next: (p: Preferences, dir: 1 | -1) => Partial<Preferences>;
}

/** The settings the appearance dialog exposes; ←/→ steps each one live. */
export const APPEARANCE_ROWS: AppearanceRow[] = [
  {
    label: "Tema",
    value: (p) => presetByName(p.theme).label,
    next: (p, d) => ({ theme: cycle(PRESETS.map((x) => x.name), presetByName(p.theme).name, d) }),
  },
  { label: "Burbujas", value: (p) => (p.bubbles === "filled" ? "rellenas" : "minimalistas"), next: (p, d) => ({ bubbles: cycle(["filled", "minimal"] as const, p.bubbles, d) }) },
  { label: "Densidad", value: (p) => (p.density === "comfortable" ? "cómoda" : "compacta"), next: (p, d) => ({ density: cycle(["comfortable", "compact"] as const, p.density, d) }) },
  { label: "Avatares", value: (p) => (p.avatars ? "sí" : "no"), next: (p) => ({ avatars: !p.avatars }) },
  { label: "Hora", value: (p) => (p.clock === "24h" ? "24 h (14:30)" : "12 h (2:30 p. m.)"), next: (p, d) => ({ clock: cycle(["24h", "12h"] as const, p.clock, d) }) },
  { label: "Fotos", value: (p) => (p.images === "terminal" ? "dentro de la terminal (si se puede)" : "visor del sistema"), next: (p, d) => ({ images: cycle(["terminal", "system"] as const, p.images, d) }) },
];

/** Ctrl+T: change the look and watch it change behind the dialog. */
export function AppearanceDialog({ index, width, location }: { index: number; width: number; location: string | null }) {
  const t = useTheme();
  const theme = t.c;
  const w = Math.min(62, width - 4);
  return (
    <Box position="absolute" top={2} left={Math.max(0, width - w - 2)} width={w} flexDirection="column" borderStyle="round" borderColor={theme.accent} backgroundColor={theme.panel} paddingX={2} paddingY={1}>
      <Text color={theme.text} bold>🎨 Apariencia</Text>
      <Text color={theme.faint}>Los cambios se ven al instante y se guardan solos.</Text>
      <Text> </Text>
      {APPEARANCE_ROWS.map((r, i) => {
        const active = i === index;
        return (
          <Box key={r.label}>
            <Text color={active ? theme.accentSoft : theme.muted} bold={active}>{padCells(`${active ? "❯" : " "} ${r.label}`, 14)}</Text>
            <Text backgroundColor={active ? theme.rowSelected : undefined} color={theme.text}>{` ‹ ${r.value(t.prefs)} › `}</Text>
          </Box>
        );
      })}
      <Text> </Text>
      <Box>
        {theme.people.slice(0, 6).map((col, i) => (
          <Text key={i} backgroundColor={col}>{"   "}</Text>
        ))}
        <Text backgroundColor={theme.accent}>{"   "}</Text>
        <Text backgroundColor={theme.bubbleOut ?? theme.rowSelected}>{"   "}</Text>
      </Box>
      <Text> </Text>
      <Text color={theme.faint}>Colores a medida: edita "colors" en</Text>
      <Text color={theme.muted}>{truncate(location ?? "~/.wacon/tui.json", w - 6)}</Text>
      <Text color={theme.faint}>{`p. ej. { "colors": { "accent": "#ff6b6b" } }`}</Text>
      <Text> </Text>
      <Text color={theme.faint}>↑↓ opción · ←→ cambiar · Esc cerrar</Text>
    </Box>
  );
}
