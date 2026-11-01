import { Box, Text } from "ink";
import { colorIndex, initials, previewLine, type ChatSummary } from "../../domain/chat.js";
import { listTime } from "../../domain/time.js";
import { cells, padCells, truncate } from "../../domain/text.js";
import { useTheme } from "../themes.js";
import { Spinner } from "./Spinner.js";

interface Props {
  chats: ChatSummary[];
  selectedJid: string | null;
  openJid: string | null;
  width: number;
  height: number;
  query: string;
  searching: boolean;
  focused: boolean;
  loaded: boolean;
  now: number;
  /** "Chats", or "Archivados" while browsing archived chats. */
  title?: string;
}

const HEADER_H = 3;

/**
 * WhatsApp's chat list: avatar, name and time on top; preview and unread
 * badge below. Virtualised — only the rows that fit are rendered, so a list
 * of thousands of chats costs the same as a list of ten.
 */
export function ChatList(p: Props) {
  const t = useTheme();
  const theme = t.c;
  // Compact density: one line per chat, twice as many on screen.
  const rowH = t.compact ? 1 : 2;
  const inner = p.width - 2; // 1-cell side margins
  const visible = Math.max(1, Math.floor((p.height - HEADER_H) / rowH));
  const sel = Math.max(0, p.chats.findIndex((c) => c.jid === p.selectedJid));
  // Keep the selection roughly a third from the top while scrolling.
  const start = Math.max(0, Math.min(sel - Math.floor(visible / 3), p.chats.length - visible));
  const rows = p.chats.slice(start, start + visible);
  const unreadTotal = p.chats.filter((c) => c.unread > 0 && !c.special).length;

  return (
    <Box flexDirection="column" width={p.width} height={p.height} backgroundColor={theme.panel}>
      <Box paddingX={1} height={1} backgroundColor={theme.header}>
        <Text color={theme.text} bold>
          {padCells(` ${p.title ?? "Chats"}`, inner - 12)}
        </Text>
        <Text color={theme.accentSoft}>{unreadTotal > 0 ? `${unreadTotal} sin leer`.padStart(12) : "".padStart(12)}</Text>
      </Box>
      <SearchBox query={p.query} active={p.searching} width={inner} />
      <Box height={1} />
      {!p.loaded ? (
        <Box paddingX={2}>
          <Spinner color={theme.accent} />
          <Text color={theme.muted}> cargando chats…</Text>
        </Box>
      ) : p.chats.length === 0 ? (
        <Box paddingX={2} flexDirection="column">
          <Text color={theme.muted}>{p.query ? `Nada coincide con "${p.query}"` : "Aún no hay chats."}</Text>
          {!p.query && <Text color={theme.faint}>Si acabas de vincular, el historial está llegando…</Text>}
        </Box>
      ) : (
        rows.map((c) => (
          <Row key={c.jid} chat={c} width={p.width} selected={c.jid === p.selectedJid && p.focused} open={c.jid === p.openJid} now={p.now} />
        ))
      )}
    </Box>
  );
}

function SearchBox({ query, active, width }: { query: string; active: boolean; width: number }) {
  const theme = useTheme().c;
  const w = width - 2;
  return (
    <Box paddingX={1} height={1}>
      <Text backgroundColor={active ? theme.rowSelected : theme.header} color={query ? theme.text : theme.muted}>
        {padCells(truncate(` ⌕ ${query || (active ? "" : w >= 34 ? "Buscar o empezar un chat (escribe)" : "Buscar (escribe)")}${active ? "▏" : ""}`, w), w)}
      </Text>
    </Box>
  );
}

function Row({ chat, width, selected, open, now }: { chat: ChatSummary; width: number; selected: boolean; open: boolean; now: number }) {
  const t = useTheme();
  const theme = t.c;
  const showAvatar = t.prefs.avatars;
  const bg = selected ? theme.rowSelected : open ? theme.rowOpen : theme.panel;
  // Wacon's own rows (IA, Agenda, Archivados) wear the accent and an icon.
  const avatarBg = chat.special ? theme.accent : theme.people[colorIndex(chat.jid, theme.people.length)];
  const avatar = chat.icon ?? (chat.isGroup ? "👥" : initials(chat.name));
  const avatarW = showAvatar ? 5 : 0; // 4 cells + gap
  const contentW = width - 2 - avatarW; // marker + right margin
  const time = chat.special ? (chat.meta ?? "") : listTime(chat.lastTs, now, t.prefs.clock === "12h");
  const preview = chat.special ? (chat.subtitle ?? "") : previewLine(chat);
  const unread = chat.unread > 0;
  const badge = unread ? ` ${chat.unread > 99 ? "99+" : chat.unread} ` : "";
  const marker = open ? "▌" : " ";
  const Badge = badge ? (
    <>
      <Text backgroundColor={bg}> </Text>
      <Text backgroundColor={theme.accent} color={theme.onAccent} bold>
        {badge}
      </Text>
    </>
  ) : null;

  if (t.compact) {
    // One line: name · preview … time [badge]
    const right = `${time}`;
    const leftW = contentW - cells(right) - 1 - (badge ? cells(badge) + 1 : 0);
    const nameW = Math.min(cells(chat.name), Math.max(6, Math.floor(leftW * 0.55)));
    const prevW = Math.max(0, leftW - nameW - 3);
    return (
      <Box backgroundColor={bg}>
        <Text color={theme.accent} backgroundColor={bg}>{marker}</Text>
        {showAvatar ? <Text backgroundColor={avatarBg} color={theme.onAccent} bold>{padCells(` ${avatar}`, 4)}</Text> : null}
        {showAvatar ? <Text backgroundColor={bg}> </Text> : null}
        <Text backgroundColor={bg} color={theme.text} bold={unread}>{truncate(chat.name, nameW)}</Text>
        <Text backgroundColor={bg} color={theme.faint}>{" · "}</Text>
        <Text backgroundColor={bg} color={unread ? theme.text : theme.muted}>
          {padCells(truncate(preview, prevW), leftW - cells(truncate(chat.name, nameW)) - 3)}
        </Text>
        <Text backgroundColor={bg}> </Text>
        <Text backgroundColor={bg} color={unread ? theme.accentSoft : theme.muted}>{right}</Text>
        {Badge}
      </Box>
    );
  }

  const nameW = contentW - cells(time) - 1;
  const previewW = contentW - cells(badge) - (badge ? 1 : 0);
  return (
    <Box flexDirection="column" backgroundColor={bg}>
      <Box>
        <Text color={theme.accent} backgroundColor={bg}>{marker}</Text>
        {showAvatar ? <Text backgroundColor={avatarBg} color={theme.onAccent} bold>{padCells(` ${avatar}`, 4)}</Text> : null}
        {showAvatar ? <Text backgroundColor={bg}> </Text> : null}
        <Text backgroundColor={bg} color={theme.text} bold={unread}>
          {padCells(truncate(chat.name, nameW), nameW)}
        </Text>
        <Text backgroundColor={bg}> </Text>
        <Text backgroundColor={bg} color={unread ? theme.accentSoft : theme.muted}>{time}</Text>
      </Box>
      <Box>
        <Text backgroundColor={bg}>{" "}</Text>
        {showAvatar ? <Text backgroundColor={avatarBg}>{"    "}</Text> : null}
        {showAvatar ? <Text backgroundColor={bg}> </Text> : null}
        <Text backgroundColor={bg} color={unread ? theme.text : theme.muted}>
          {padCells(truncate(preview, previewW), previewW)}
        </Text>
        {Badge}
      </Box>
    </Box>
  );
}
