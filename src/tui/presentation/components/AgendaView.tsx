import type { ReactNode } from "react";
import { Box, Text } from "ink";
import type { AgendaItem, AgendaSection } from "../../domain/agenda.js";
import { clock } from "../../domain/time.js";
import { cells, padCells, truncate } from "../../domain/text.js";
import { useTheme } from "../themes.js";
import { Spinner } from "./Spinner.js";

/**
 * 📅 Agenda: what is coming up, by day — events and tasks Wacon keeps, many
 * of them added from what the AI found in your chats. A list reads far
 * better in a terminal than a month grid.
 */

interface Props {
  sections: AgendaSection[];
  loading: boolean;
  /** Index into the flattened items. */
  index: number;
  focused: boolean;
  staleSuggestions: number;
  /** Inline "new task" input, when open. */
  newTask: string | null;
  chatName: (jid: string) => string | null;
  hasAgent: boolean;
  width: number;
  height: number;
}

export const flatItems = (sections: readonly AgendaSection[]): AgendaItem[] => sections.flatMap((s) => s.items);

export function AgendaView({ sections, loading, index, focused, staleSuggestions, newTask, chatName, hasAgent, width, height }: Props) {
  const t = useTheme();
  const theme = t.c;
  const hour12 = t.prefs.clock === "12h";
  const inner = width - 4;
  const total = flatItems(sections).length;

  // Lines: section headers + items, then scroll so the selection stays visible.
  type L = { key: string; node: ReactNode; item?: number };
  const lines: L[] = [];
  let n = 0;
  for (const s of sections) {
    const color = s.tone === "overdue" ? theme.error : s.tone === "undated" ? theme.muted : theme.accentSoft;
    lines.push({ key: `h-${s.label}`, node: <Text color={color} bold>{s.label.toUpperCase()}</Text> });
    for (const i of s.items) {
      const idx = n++;
      const active = focused && idx === index;
      const bg = active ? theme.rowSelected : theme.bg;
      const ts = i.kind === "event" ? i.startTs : i.dueTs;
      const when = i.kind === "event" ? clock(i.startTs, hour12) : ts ? "tarea" : "";
      const from = i.chatJid ? chatName(i.chatJid) : null;
      const left = `${i.kind === "event" ? "📅" : "☐"} ${padCells(when, 6)} `;
      const titleW = Math.max(8, inner - cells(left) - (from ? Math.min(24, cells(from) + 3) : 0));
      lines.push({
        key: `${i.kind}-${i.id}`,
        item: idx,
        node: (
          <Text backgroundColor={bg}>
            <Text backgroundColor={bg} color={active ? theme.accent : theme.muted}>{left}</Text>
            <Text backgroundColor={bg} color={theme.text} bold={active}>{padCells(truncate(i.title, titleW), titleW)}</Text>
            {from ? <Text backgroundColor={bg} color={theme.faint}>{` · ${truncate(from, 21)}`}</Text> : null}
          </Text>
        ),
      });
    }
    lines.push({ key: `g-${s.label}`, node: <Text> </Text> });
  }

  const footerH = 2 + (staleSuggestions ? 1 : 0) + (newTask !== null ? 3 : 0);
  const bodyH = Math.max(1, height - 2 - footerH);
  const selLine = Math.max(0, lines.findIndex((l) => l.item === index));
  const start = Math.max(0, Math.min(selLine - Math.floor(bodyH / 2), lines.length - bodyH));

  return (
    <Box flexDirection="column" width={width} height={height} backgroundColor={theme.bg}>
      <Box height={1} width={width} backgroundColor={theme.header}>
        <Text backgroundColor={theme.header} color={theme.accent} bold>{" 📅 Agenda "}</Text>
        <Text backgroundColor={theme.header} color={theme.muted}>{total ? `${total} pendiente${total > 1 ? "s" : ""}` : ""}</Text>
        {loading ? (
          <Text backgroundColor={theme.header}>
            {"  "}
            <Spinner color={theme.accent} />
          </Text>
        ) : null}
      </Box>
      <Box flexDirection="column" height={bodyH + 1} paddingX={2} paddingTop={1} overflow="hidden">
        {total === 0 && !loading ? (
          <>
            <Text color={theme.text} bold>Tu agenda está vacía.</Text>
            <Text color={theme.muted}>{truncate(hasAgent ? "Pulsa i y la IA buscará fechas y pendientes en tus chats recientes;" : "Elige un agente de IA (Ctrl+L) para que busque fechas en tus chats,", inner)}</Text>
            <Text color={theme.muted}>{truncate(hasAgent ? "te propondrá cada uno para que lo añadas con ↵." : "o pulsa n para añadir una tarea a mano.", inner)}</Text>
          </>
        ) : (
          lines.slice(start, start + bodyH).map((l) => <Box key={l.key}>{l.node}</Box>)
        )}
      </Box>
      {newTask !== null ? (
        <Box marginX={1} borderStyle="round" borderColor={theme.accent} paddingX={1}>
          <Text color={theme.accentSoft}>{"☐ Nueva tarea: "}</Text>
          <Text color={theme.text}>{newTask}</Text>
          <Text inverse> </Text>
        </Box>
      ) : null}
      {staleSuggestions ? (
        <Box paddingX={2}>
          <Text color={theme.faint}>{truncate(`${staleSuggestions} sugerencias antiguas sin fecha útil (del primer análisis) · x para descartarlas`, inner)}</Text>
        </Box>
      ) : null}
      <Box paddingX={2}>
        <Text color={theme.faint}>{truncate(newTask !== null ? "↵ añadir · Esc cancelar" : `↑↓ elegir · d hecho · Supr cancelar · n nueva tarea${hasAgent ? " · i buscar fechas con IA" : ""} · Esc volver`, inner)}</Text>
      </Box>
    </Box>
  );
}
