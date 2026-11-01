import { Box, Text } from "ink";
import type { ChatSummary } from "../../domain/chat.js";
import { colorIndex, initials, SELF_SUBTITLE } from "../../domain/chat.js";
import { fileNameOf } from "../../domain/input.js";
import { cells, padCells, truncate } from "../../domain/text.js";
import type { ConversationState } from "../../application/controller.js";
import type { Line } from "../layout.js";
import { splitAtCursor, type EditorState } from "../editor.js";
import { useTheme } from "../themes.js";
import { Spinner, TypingDots } from "./Spinner.js";

export function ChatHeader({ chat, convo, width }: { chat: ChatSummary; convo: ConversationState | undefined; width: number }) {
  const theme = useTheme().c;
  const avatarBg = theme.people[colorIndex(chat.jid, theme.people.length)];
  const p = convo?.presence;
  const members = Object.keys(convo?.memberNames ?? {}).length;
  const sub =
    chat.isSelf ? SELF_SUBTITLE
    : p?.status === "typing" ? null
    : p?.status === "recording" ? "grabando audio…"
    : p?.status === "online" ? "en línea"
    : p?.lastSeenRelative ? `últ. vez ${p.lastSeenRelative}`
    : chat.isGroup ? (members ? `${members} participantes` : "grupo")
    : "";
  return (
    <Box height={1} width={width} backgroundColor={theme.header}>
      <Text backgroundColor={avatarBg} color={theme.onAccent} bold>{padCells(` ${chat.isGroup ? "👥" : initials(chat.name)}`, 4)}</Text>
      <Text backgroundColor={theme.header} color={theme.text} bold>{` ${truncate(chat.name, Math.max(8, width - 30))}`}</Text>
      <Text backgroundColor={theme.header}>{"  "}</Text>
      {p?.status === "typing" ? (
        <TypingDots color={theme.accentSoft} />
      ) : (
        <Text backgroundColor={theme.header} color={p?.status === "online" ? theme.accentSoft : theme.muted}>{sub}</Text>
      )}
      {convo?.loading ? (
        <Text backgroundColor={theme.header}>
          {"  "}
          <Spinner color={theme.accent} />
        </Text>
      ) : null}
    </Box>
  );
}

/** Renders exactly the lines that fit — the layout was computed upstream. */
export function Messages({ lines, width, height, loadingOlder, atTop, empty }: { lines: Line[]; width: number; height: number; loadingOlder: boolean; atTop: boolean; empty: boolean }) {
  const theme = useTheme().c;
  const pad = Math.max(0, height - lines.length - (atTop ? 1 : 0));
  return (
    <Box flexDirection="column" width={width} height={height} backgroundColor={theme.bg}>
      {atTop ? (
        <Box justifyContent="center" height={1}>
          {loadingOlder ? (
            <Text color={theme.muted}>
              <Spinner color={theme.accent} /> cargando anteriores…
            </Text>
          ) : (
            <Text color={theme.faint}>· inicio de lo descargado ·</Text>
          )}
        </Box>
      ) : null}
      {empty ? (
        <Box flexGrow={1} justifyContent="center" alignItems="center">
          <Text color={theme.faint}>Sin mensajes todavía. Escribe abajo para empezar.</Text>
        </Box>
      ) : (
        <>
          {pad > 0 ? <Box height={pad} /> : null}
          {lines.map((l) => (
            <Box key={l.key} height={1} width={width} justifyContent={l.align === "right" ? "flex-end" : l.align === "center" ? "center" : "flex-start"} paddingX={1}>
              <Text wrap="truncate">
                {l.parts.map((part, i) => (
                  <Text key={i} color={part.color} backgroundColor={part.bg} bold={part.bold} dimColor={part.dim} italic={part.italic}>
                    {part.text}
                  </Text>
                ))}
              </Text>
            </Box>
          ))}
        </>
      )}
    </Box>
  );
}

interface ComposerProps {
  editor: EditorState;
  attachment: string | null;
  focused: boolean;
  width: number;
  /** The message being answered, shown above the input like WhatsApp. */
  replyTo?: { sender: string; text: string; color: string } | null;
}

/**
 * The message bar. Grows with multi-line text (up to 5 lines), shows a
 * cursor only when focused, and turns into "attachment + caption" when a
 * file has been dropped or picked — WhatsApp Web's send-with-caption flow.
 */
export function Composer({ editor, attachment, focused, width, replyTo }: ComposerProps) {
  const theme = useTheme().c;
  const [before, at, after] = splitAtCursor(editor);
  const empty = editor.text.length === 0;
  const placeholder = attachment ? "Añade un comentario (opcional)…" : "Escribe un mensaje";
  return (
    <Box flexDirection="column" width={width} backgroundColor={theme.header} paddingX={1}>
      {replyTo ? (
        <Box height={1}>
          <Text color={replyTo.color}>{"▎↩ "}</Text>
          <Text color={replyTo.color} bold>{truncate(replyTo.sender, 18)}</Text>
          <Text color={theme.muted}>{` ${truncate(replyTo.text, Math.max(8, width - 40))}`}</Text>
          <Text color={theme.faint}>{"  Esc cancela"}</Text>
        </Box>
      ) : null}
      {!attachment && /^\/(voz|sticker)\b/i.test(editor.text) ? (
        <Box height={1}>
          <Text color={theme.accentSoft}>{/^\/voz/i.test(editor.text) ? "🎤 ↵ lo enviará como nota de voz (con tu TTS configurado)" : "💟 ↵ enviará un sticker de ese ánimo · sin ánimo abre el selector"}</Text>
        </Box>
      ) : null}
      {attachment ? (
        <Box height={1}>
          <Text backgroundColor={theme.bubbleOut} color={theme.text}>{` 📎 ${truncate(fileNameOf(attachment), width - 30)} `}</Text>
          <Text color={theme.muted}>{"  ↵ enviar · ⌫ quitar"}</Text>
        </Box>
      ) : null}
      <Box borderStyle="round" borderColor={focused ? theme.accent : theme.border} paddingX={1} width={width - 2}>
        {empty ? (
          <Text>
            {focused ? <Text inverse> </Text> : null}
            <Text color={theme.faint}>{placeholder}</Text>
          </Text>
        ) : (
          <Text color={theme.text} wrap="wrap">
            {before}
            {focused ? <Text inverse>{at === "\n" || at === "" ? " " : at}</Text> : at}
            {at === "\n" ? "\n" : ""}
            {after}
          </Text>
        )}
      </Box>
    </Box>
  );
}

export const composerHeight = (editor: EditorState, attachment: string | null, width: number, replying = false): number => {
  const inner = Math.max(1, width - 6);
  const rows = editor.text
    .split("\n")
    .reduce((n, l) => n + Math.max(1, Math.ceil(cells(l + " ") / inner)), 0);
  const hint = attachment || /^\/(voz|sticker)\b/i.test(editor.text) ? 1 : 0;
  return Math.min(5, rows) + 2 + hint + (replying ? 1 : 0);
};
