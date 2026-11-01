import { Box, Text } from "ink";
import type { SearchHit } from "../../application/ports.js";
import { clock, listTime } from "../../domain/time.js";
import { cells, padCells, truncate } from "../../domain/text.js";
import { useTheme } from "../themes.js";
import { Spinner } from "./Spinner.js";

const centered = (width: number, w: number) => Math.max(0, Math.floor((width - w) / 2));

/** Ctrl+F: search inside the open conversation; ↵ jumps to the message. */
export function SearchDialog(p: { query: string; hits: SearchHit[]; index: number; loading: boolean; width: number; height: number; names: (h: SearchHit) => string; now: number }) {
  const t = useTheme();
  const theme = t.c;
  const w = Math.min(76, p.width - 4);
  const max = Math.max(3, Math.min(10, p.height - 9));
  const start = Math.max(0, Math.min(p.index - Math.floor(max / 2), p.hits.length - max));
  return (
    <Box position="absolute" top={2} left={centered(p.width, w)} width={w} flexDirection="column" borderStyle="round" borderColor={theme.accent} backgroundColor={theme.panel} paddingX={1}>
      <Text color={theme.text}>
        <Text color={theme.accentSoft}>⌕ </Text>
        {p.query}
        <Text inverse> </Text>
        {p.query ? "" : <Text color={theme.faint}> buscar en esta conversación</Text>}
        {p.loading ? (
          <Text>
            {"  "}
            <Spinner color={theme.accent} />
          </Text>
        ) : null}
      </Text>
      <Text color={theme.border}>{"─".repeat(w - 4)}</Text>
      {p.query.trim().length < 2 ? <Text color={theme.faint}>Escribe al menos 2 letras…</Text> : null}
      {p.query.trim().length >= 2 && !p.loading && p.hits.length === 0 ? <Text color={theme.muted}>Sin resultados</Text> : null}
      {p.hits.slice(start, start + max).map((h, i) => {
        const active = start + i === p.index;
        const bg = active ? theme.rowSelected : theme.panel;
        const when = `${listTime(h.ts, p.now, t.prefs.clock === "12h")} ${clock(h.ts, t.prefs.clock === "12h")}`;
        const who = h.fromMe ? "Tú" : p.names(h);
        const textW = w - 6 - cells(when) - 10;
        return (
          <Box key={h.id}>
            <Text backgroundColor={bg} color={h.fromMe ? theme.accentSoft : theme.text} bold>{padCells(truncate(who, 9), 10)}</Text>
            <Text backgroundColor={bg} color={active ? theme.text : theme.muted}>{padCells(truncate(h.snippet.replace(/\s+/g, " "), textW), textW)}</Text>
            <Text backgroundColor={bg} color={theme.faint}>{` ${when}`}</Text>
          </Box>
        );
      })}
      <Text color={theme.faint}>{`${p.hits.length ? `${p.index + 1}/${p.hits.length} · ` : ""}↑↓ elegir · ↵ ir al mensaje · Esc cerrar`}</Text>
    </Box>
  );
}

const MOOD_ICON: Record<string, string> = {
  risa: "😂", carino: "🥰", saludo: "👋", ok: "👍", travieso: "😜", beso: "😘", sorpresa: "😮", disculpa: "🙏", molesto: "😤", neutral: "🙂",
};

/** Ctrl+S: pick a mood; Wacon sends the sticker you usually use for it with this person. */
export function StickerDialog(p: { moods: string[]; index: number; width: number }) {
  const theme = useTheme().c;
  const w = Math.min(60, p.width - 4);
  const perRow = Math.max(1, Math.floor((w - 4) / 14));
  const rows: string[][] = [];
  for (let i = 0; i < p.moods.length; i += perRow) rows.push(p.moods.slice(i, i + perRow));
  return (
    <Box position="absolute" top={3} left={centered(p.width, w)} width={w} flexDirection="column" borderStyle="round" borderColor={theme.accent} backgroundColor={theme.panel} paddingX={1}>
      <Text color={theme.text} bold>💟 Enviar sticker</Text>
      <Text color={theme.faint}>Elige el ánimo; Wacon elige el sticker que sueles usar con esta persona.</Text>
      <Text> </Text>
      {p.moods.length === 0 ? (
        <Text color={theme.muted}>
          <Spinner color={theme.accent} /> cargando…
        </Text>
      ) : (
        rows.map((row, r) => (
          <Box key={r}>
            {row.map((m, c) => {
              const i = r * perRow + c;
              const active = i === p.index;
              return (
                <Text key={m} backgroundColor={active ? theme.accent : theme.rowSelected} color={active ? theme.onAccent : theme.text} bold={active}>
                  {padCells(` ${MOOD_ICON[m] ?? "✨"} ${m}`, 13)}
                  <Text backgroundColor={theme.panel}> </Text>
                </Text>
              );
            })}
          </Box>
        ))
      )}
      <Text> </Text>
      <Text color={theme.faint}>←→↑↓ elegir · ↵ enviar · Esc cerrar</Text>
    </Box>
  );
}

export interface MessageAction {
  key: string;
  label: string;
  id: "reply" | "react" | "open" | "copy" | "retry";
}

/** ↵ on a message: what you can do with it — WhatsApp's long-press menu. */
export function ActionsMenu({ actions, index, width, preview }: { actions: MessageAction[]; index: number; width: number; preview: string }) {
  const theme = useTheme().c;
  const w = Math.min(44, width - 4);
  return (
    <Box position="absolute" top={4} left={Math.max(0, width - w - 3)} width={w} flexDirection="column" borderStyle="round" borderColor={theme.accent} backgroundColor={theme.panel} paddingX={1}>
      <Text color={theme.muted}>{truncate(`“${preview}”`, w - 4)}</Text>
      <Text color={theme.border}>{"─".repeat(w - 4)}</Text>
      {actions.map((a, i) => {
        const active = i === index;
        const bg = active ? theme.rowSelected : theme.panel;
        return (
          <Box key={a.id}>
            <Text backgroundColor={bg} color={theme.accentSoft} bold>{` ${a.key} `}</Text>
            <Text backgroundColor={bg} color={active ? theme.text : theme.muted} bold={active}>{padCells(` ${a.label}`, w - 7)}</Text>
          </Box>
        );
      })}
      <Text color={theme.faint}>↑↓ · ↵ o la letra · Esc</Text>
    </Box>
  );
}

export const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

/** The six quick reactions; 1–6 or ←→ + ↵. Choosing yours again removes it. */
export function ReactionPicker({ index, width, current }: { index: number; width: number; current: string | null }) {
  const theme = useTheme().c;
  const w = Math.min(46, width - 4);
  return (
    <Box position="absolute" top={4} left={Math.max(0, width - w - 3)} width={w} flexDirection="column" borderStyle="round" borderColor={theme.accent} backgroundColor={theme.panel} paddingX={1}>
      <Text color={theme.text} bold>Reaccionar</Text>
      <Box>
        {QUICK_REACTIONS.map((e, i) => (
          <Text key={e} backgroundColor={i === index ? theme.accent : current === e ? theme.rowSelected : theme.panel}>{` ${e} `}</Text>
        ))}
      </Box>
      <Text color={theme.faint}>{current ? "1–6 / ←→ ↵ · tu misma reacción la quita · Esc" : "1–6 / ←→ ↵ · Esc"}</Text>
    </Box>
  );
}
