import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Box, Text, useAnimation, useApp, useInput, usePaste, useWindowSize, type Key } from "ink";
import type { UltraController } from "../application/controller.js";
import type { FilePort } from "../application/ports.js";
import { matchesQuery } from "../domain/chat.js";
import { commonPrefix, parseDroppedPath } from "../domain/input.js";
import { isOpenable } from "../domain/message.js";
import { buildTimeline } from "../domain/timeline.js";
import { layoutConversation } from "./layout.js";
import * as ed from "./editor.js";
import { theme } from "./theme.js";
import { ChatList } from "./components/ChatList.js";
import { ChatHeader, Composer, Messages, composerHeight } from "./components/Conversation.js";
import { AttachDialog, BannerToast, HelpOverlay, Palette, StatusBar, type PaletteItem } from "./components/Chrome.js";
import { LinkScreen } from "./components/LinkScreen.js";

/**
 * Root view. Owns only UI state (focus, scroll, overlays, the text being
 * typed); everything about WhatsApp lives in the controller. All keys go
 * through ONE router below, so there is never a question of which widget
 * swallowed a keystroke — the bug class that made the old UI feel stuck.
 */

type Focus = "list" | "composer" | "messages";
type Overlay = null | "palette" | "help" | "attach";

const HINTS: Record<Focus, string> = {
  list: "↑↓ elegir · ↵ abrir · escribe para buscar · ^K ir a… · ? ayuda",
  composer: "↵ enviar · ⇧↵ línea · ^O adjuntar · ↑ mensajes · Esc chats · ^K ir a…",
  messages: "↑↓ elegir · ↵ abrir/reintentar · Esc volver a escribir",
};

const printable = (input: string, key: Key) => input.length > 0 && !key.ctrl && !key.meta && !key.escape && !key.return && !key.tab && !/[\x00-\x1f\x7f]/.test(input);

export function App({ controller, files }: { controller: UltraController; files: FilePort }) {
  const s = useSyncExternalStore(controller.subscribe, controller.getState);
  // Some hosts (piped, test harnesses) report no size; never lay out on NaN.
  const size = useWindowSize();
  const columns = size.columns || 100;
  const rows = size.rows || 30;
  const { exit } = useApp();

  const [focus, setFocus] = useState<Focus>("list");
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [query, setQuery] = useState("");
  const [selectedJid, setSelectedJid] = useState<string | null>(null);
  const [editor, setEditorState] = useState<ed.EditorState>({ text: "", cursor: 0 });
  const [attachment, setAttachmentState] = useState<string | null>(null);
  // Keystrokes can arrive faster than React re-renders (fast typing, a
  // paste, a terminal flushing a burst). Handlers read these refs, which are
  // updated synchronously per key — reading the rendered `editor` instead
  // made Enter send a stale, empty draft.
  const editorRef = useRef(editor);
  const attachmentRef = useRef(attachment);
  const setEditor = (next: ed.EditorState | ((e: ed.EditorState) => ed.EditorState)) => {
    editorRef.current = typeof next === "function" ? next(editorRef.current) : next;
    setEditorState(editorRef.current);
  };
  const setAttachment = (next: string | null) => {
    attachmentRef.current = next;
    setAttachmentState(next);
  };
  const [scroll, setScroll] = useState(0); // lines up from the bottom
  const [selMsg, setSelMsg] = useState<string | null>(null);
  const [palette, setPalette] = useState({ query: "", index: 0 });
  const [attach, setAttach] = useState<{ value: string; suggestions: string[]; error: string | null }>({ value: "", suggestions: [], error: null });
  const quitArmedAt = useRef(0);

  const openChat = s.openJid ? (s.chats.find((c) => c.jid === s.openJid) ?? null) : null;
  const convo = s.openJid ? s.conversations[s.openJid] : undefined;

  // ── geometry ─────────────────────────────────────────────
  // Below ~84 columns there is no room for two panes: behave like the phone
  // app — the list OR the conversation, Esc goes back.
  const narrow = columns < 84;
  const listW = narrow ? columns : Math.max(30, Math.min(48, Math.floor(columns * 0.34)));
  const convW = narrow ? columns : columns - listW;
  const bodyH = Math.max(4, rows - 1);
  const compH = composerHeight(editor, attachment, convW);
  const msgsH = Math.max(1, bodyH - 1 - compH);
  const showList = !narrow || focus === "list" || !openChat;
  const showConvo = !narrow || (focus !== "list" && !!openChat);

  // ── derived data ─────────────────────────────────────────
  const filtered = useMemo(() => s.chats.filter((c) => matchesQuery(c, query)), [s.chats, query]);
  const selJid = filtered.some((c) => c.jid === selectedJid) ? selectedJid : (filtered[0]?.jid ?? null);

  // New arrivals glow for ~2 s; animate only while something is glowing.
  const flashing = !!convo?.messages.some((m) => m.arrivedAt && Date.now() - m.arrivedAt < 2200);
  useAnimation({ interval: 250, isActive: flashing });
  const now = Date.now();

  const timeline = useMemo(() => (convo ? buildTimeline(convo.messages, now, convo.unreadAtOpen) : []), [convo, now]);
  const msgIds = useMemo(() => timeline.flatMap((t) => (t.type === "msg" ? [t.msg.id] : [])), [timeline]);
  const view = useMemo(
    () => layoutConversation(timeline, { width: convW - 2, isGroup: !!openChat?.isGroup, memberNames: convo?.memberNames ?? {}, selectedId: focus === "messages" ? selMsg : null, now }),
    [timeline, convW, openChat?.isGroup, convo?.memberNames, focus, selMsg, now]
  );
  const total = view.lines.length;
  const maxScroll = Math.max(0, total - msgsH);
  const off = Math.min(scroll, maxScroll);
  const visible = view.lines.slice(Math.max(0, total - msgsH - off), total - off);
  const atTop = off >= maxScroll && total > 0 && total >= msgsH - 1;

  // ── effects ──────────────────────────────────────────────
  // Reaching the top of what is loaded pulls the previous page; the
  // bottom-anchored offset keeps the view still while it is prepended.
  useEffect(() => {
    if (convo && off >= maxScroll - 1 && convo.hasMore && !convo.loadingOlder && !convo.loading && total > msgsH) void controller.loadOlder();
  }, [off, maxScroll, convo, total, msgsH, controller]);

  useEffect(() => {
    if (!s.notice) return;
    const t = setTimeout(() => controller.clearNotice(), s.notice.tone === "error" ? 8000 : 4500);
    return () => clearTimeout(t);
  }, [s.notice, controller]);

  useEffect(() => {
    if (!s.banner) return;
    const t = setTimeout(() => controller.dismissBanner(), 7000);
    return () => clearTimeout(t);
  }, [s.banner, controller]);

  useEffect(() => {
    if (!openChat || openChat.isGroup) return;
    const t = setInterval(() => void controller.refreshPresence(openChat.jid), 30_000);
    return () => clearInterval(t);
  }, [openChat?.jid, openChat?.isGroup, controller]);

  // Keep a selected message on screen.
  useEffect(() => {
    if (focus !== "messages" || !selMsg) return;
    const span = view.spans.get(selMsg);
    if (!span) return;
    const top = total - msgsH - off;
    if (span[0] < top) setScroll(Math.min(maxScroll, total - msgsH - span[0]));
    else if (span[1] >= total - off) setScroll(Math.max(0, total - 1 - span[1]));
  }, [selMsg, focus, view, total, msgsH, off, maxScroll]);

  // ── actions ──────────────────────────────────────────────
  /** Switching chats keeps each chat's unsent draft, like WhatsApp. */
  const switchTo = (jid: string, nextFocus: Focus = "composer") => {
    if (s.openJid) controller.setDraft(s.openJid, editorRef.current.text);
    if (jid !== s.openJid) {
      const draft = controller.getState().drafts[jid] ?? "";
      setEditor(ed.fromText(draft));
      setAttachment(null);
      setScroll(0);
      setSelMsg(null);
      void controller.openChat(jid);
    }
    setSelectedJid(jid);
    setFocus(nextFocus);
  };

  const step = (dir: 1 | -1) => {
    if (filtered.length === 0) return;
    const base = s.openJid ?? selJid;
    const i = filtered.findIndex((c) => c.jid === base);
    const next = filtered[(i + dir + filtered.length) % filtered.length]!;
    switchTo(next.jid, focus === "list" ? "list" : "composer");
  };

  const send = () => {
    if (!openChat) return;
    const text = editorRef.current.text.trim();
    const file = attachmentRef.current;
    if (file) {
      void controller.sendFile(file, text || undefined);
      setAttachment(null);
    } else if (text) {
      void controller.sendText(text);
    } else return;
    setEditor({ text: "", cursor: 0 });
    setScroll(0);
  };

  const quit = () => {
    controller.stop();
    exit();
  };

  const paletteItems = useMemo<PaletteItem[]>(() => {
    const actions: PaletteItem[] = [
      { id: "a:attach", label: "Adjuntar archivo", hint: "Ctrl+O", kind: "action" },
      { id: "a:retry", label: "Reintentar último envío fallido", hint: "Ctrl+R", kind: "action" },
      { id: "a:banner", label: "Abrir el chat del último aviso", hint: "Ctrl+G", kind: "action" },
      { id: "a:reload", label: "Recargar chats", kind: "action" },
      { id: "a:help", label: "Ver atajos de teclado", hint: "?", kind: "action" },
      { id: "a:quit", label: "Salir de Wacon", hint: "Ctrl+C ×2", kind: "action" },
    ].filter((a) => !palette.query || a.label.toLowerCase().includes(palette.query.toLowerCase())) as PaletteItem[];
    const chats = s.chats
      .filter((c) => matchesQuery(c, palette.query))
      .slice(0, 40)
      .map<PaletteItem>((c) => ({ id: `c:${c.jid}`, label: c.name, hint: c.unread ? `${c.unread} sin leer` : c.isGroup ? "grupo" : "", kind: "chat" }));
    return palette.query ? [...chats, ...actions] : [...actions.slice(0, 3), ...chats, ...actions.slice(3)];
  }, [palette.query, s.chats]);

  const openAttach = () => {
    if (!openChat) {
      controller.inform("Abre un chat primero para adjuntar", "error");
      return;
    }
    setAttach({ value: attach.value || files.home(), suggestions: [], error: null });
    setOverlay("attach");
  };

  const runPalette = (it: PaletteItem | undefined) => {
    setOverlay(null);
    if (!it) return;
    if (it.kind === "chat") return switchTo(it.id.slice(2));
    if (it.id === "a:attach") return openAttach();
    if (it.id === "a:retry") return retryLast();
    if (it.id === "a:banner") return jumpToBanner();
    if (it.id === "a:reload") return void controller.refreshChats();
    if (it.id === "a:help") return setOverlay("help");
    if (it.id === "a:quit") return quit();
  };

  const retryLast = () => {
    const failed = controller.lastFailed();
    if (failed) void controller.retry(failed.id);
    else controller.inform("No hay envíos fallidos");
  };
  const jumpToBanner = () => {
    if (s.banner) switchTo(s.banner.chatJid);
  };

  // ── input router ─────────────────────────────────────────
  useInput((input, key) => {
    // Ctrl+C: first clears what you are typing, a second press quits —
    // a single stray press never throws away a half-written message.
    if (key.ctrl && input === "c") {
      if (overlay) return setOverlay(null);
      if (editorRef.current.text || attachmentRef.current) {
        setEditor({ text: "", cursor: 0 });
        setAttachment(null);
        quitArmedAt.current = 0;
        return;
      }
      if (Date.now() - quitArmedAt.current < 1500) return quit();
      quitArmedAt.current = Date.now();
      controller.inform("Pulsa Ctrl+C otra vez para salir");
      return;
    }
    if (s.link.phase !== "ready") return;

    if (overlay === "help") {
      if (key.escape || key.return || input === "?" || input === "q") setOverlay(null);
      return;
    }
    if (overlay === "palette") {
      const n = paletteItems.length;
      if (key.escape) return setOverlay(null);
      if (key.return) return runPalette(paletteItems[palette.index]);
      if (key.upArrow) return setPalette((p) => ({ ...p, index: (p.index - 1 + n) % Math.max(1, n) }));
      if (key.downArrow || key.tab) return setPalette((p) => ({ ...p, index: (p.index + 1) % Math.max(1, n) }));
      if (key.backspace || key.delete) return setPalette((p) => ({ query: p.query.slice(0, -1), index: 0 }));
      if (printable(input, key)) return setPalette((p) => ({ query: p.query + input, index: 0 }));
      return;
    }
    if (overlay === "attach") return handleAttach(input, key);

    // Global shortcuts (non-typable, so safe while composing).
    if (key.ctrl && input === "k") {
      setPalette({ query: "", index: 0 });
      return setOverlay("palette");
    }
    if ((key.ctrl && input === "n") || (key.meta && key.downArrow)) return step(1);
    if ((key.ctrl && input === "p") || (key.meta && key.upArrow)) return step(-1);
    if (key.ctrl && input === "g") return jumpToBanner();
    if (key.ctrl && input === "o") return openAttach();
    if (key.ctrl && input === "r") return retryLast();
    if (openChat && (key.pageUp || key.pageDown)) {
      const pageSize = Math.max(1, msgsH - 2);
      return setScroll((v) => Math.max(0, Math.min(maxScroll, v + (key.pageUp ? pageSize : -pageSize))));
    }

    if (focus === "list") return handleList(input, key);
    if (focus === "messages") return handleMessages(input, key);
    return handleComposer(input, key);
  });

  const handleList = (input: string, key: Key) => {
    const i = Math.max(0, filtered.findIndex((c) => c.jid === selJid));
    const move = (to: number) => setSelectedJid(filtered[Math.max(0, Math.min(filtered.length - 1, to))]?.jid ?? null);
    if (key.upArrow) return move(i - 1);
    if (key.downArrow) return move(i + 1);
    if (key.home) return move(0);
    if (key.end) return move(filtered.length - 1);
    if (key.return) return selJid ? switchTo(selJid) : undefined;
    if (key.escape) return setQuery("");
    if ((key.tab || key.rightArrow) && openChat) return setFocus("composer");
    if (key.backspace || key.delete) return setQuery((q) => q.slice(0, -1));
    if (input === "?" && !query) return setOverlay("help");
    // Typing anywhere in the list filters it — no "search mode" to enter.
    if (printable(input, key) && !(input === " " && !query)) setQuery((q) => q + input);
  };

  const handleMessages = (input: string, key: Key) => {
    const i = selMsg ? msgIds.indexOf(selMsg) : msgIds.length - 1;
    if (key.escape || key.tab) return setFocus("composer");
    if (key.upArrow) return setSelMsg(msgIds[Math.max(0, i - 1)] ?? null);
    if (key.downArrow) {
      if (i >= msgIds.length - 1) return setFocus("composer");
      return setSelMsg(msgIds[i + 1] ?? null);
    }
    if (key.return && selMsg) {
      const m = convo?.messages.find((x) => x.id === selMsg);
      if (!m) return;
      if (m.status === "failed") return void controller.retry(m.id);
      if (isOpenable(m.kind)) return void controller.openMedia(m.id);
      controller.inform("Ese mensaje no tiene adjunto");
      return;
    }
    // Typing jumps straight back into the composer with that character.
    if (printable(input, key)) {
      setFocus("composer");
      setEditor((e) => ed.insert(e, input));
    }
  };

  const handleComposer = (input: string, key: Key) => {
    // Esc goes back to the list, keeping the draft — the phone's "back".
    if (key.escape) return setFocus("list");
    if (key.tab) return setFocus("list");
    const newline = (key.return && (key.shift || key.meta)) || (key.ctrl && input === "j") || input === "\n";
    if (newline) return setEditor((e) => ed.insert(e, "\n"));
    if (key.return) return send();
    if (key.upArrow && !editorRef.current.text) {
      if (msgIds.length === 0) return;
      setSelMsg(msgIds[msgIds.length - 1] ?? null);
      return setFocus("messages");
    }
    if (key.backspace) {
      if (!editorRef.current.text && attachmentRef.current) return setAttachment(null);
      return setEditor((e) => (key.ctrl || key.meta ? ed.deleteWordBack(e) : ed.backspace(e)));
    }
    if (key.delete) return setEditor(ed.del);
    if (key.leftArrow) return setEditor((e) => (key.ctrl || key.meta ? ed.wordLeft(e) : ed.left(e)));
    if (key.rightArrow) return setEditor((e) => (key.ctrl || key.meta ? ed.wordRight(e) : ed.right(e)));
    if (key.home || (key.ctrl && input === "a")) return setEditor(ed.home);
    if (key.end || (key.ctrl && input === "e")) return setEditor(ed.end);
    if (key.ctrl && input === "w") return setEditor(ed.deleteWordBack);
    if (key.ctrl && input === "u") return setEditor(ed.deleteToLineStart);
    if (printable(input, key)) setEditor((e) => ed.insert(e, input));
  };

  const handleAttach = (input: string, key: Key) => {
    if (key.escape) return setOverlay(null);
    if (key.tab) {
      const sugs = files.complete(attach.value);
      if (sugs.length === 1) return setAttach({ value: sugs[0]!, suggestions: [], error: null });
      const prefix = commonPrefix(sugs);
      return setAttach({ value: prefix.length > attach.value.length ? prefix : attach.value, suggestions: sugs.map((x) => x.split(/[\\/]/).filter(Boolean).pop() + (/[\\/]$/.test(x) ? "/" : "")), error: sugs.length ? null : "Nada coincide" });
    }
    if (key.return) {
      const path = parseDroppedPath(attach.value) ?? attach.value.trim().replace(/^"|"$/g, "");
      if (files.exists(path)) {
        setAttachment(path);
        setOverlay(null);
        setFocus("composer");
        return;
      }
      return setAttach((a) => ({ ...a, error: /[\\/]$/.test(path) ? "Es una carpeta — sigue escribiendo o usa Tab" : "No existe ese archivo" }));
    }
    if (key.backspace || key.delete) return setAttach((a) => ({ ...a, value: a.value.slice(0, -1), error: null }));
    if (key.ctrl && input === "u") return setAttach({ value: "", suggestions: [], error: null });
    if (printable(input, key)) setAttach((a) => ({ ...a, value: a.value + input, error: null }));
  };

  // Pasted text arrives whole (bracketed paste). A dropped file is a pasted
  // path — attach it instead of typing it out.
  usePaste((text) => {
    if (s.link.phase !== "ready") return;
    if (overlay === "attach") return setAttach({ value: text.trim(), suggestions: [], error: null });
    if (overlay === "palette") return setPalette((p) => ({ query: p.query + text.trim(), index: 0 }));
    if (overlay) return;
    const dropped = parseDroppedPath(text);
    if (dropped && files.exists(dropped)) {
      if (!openChat) return controller.inform("Abre un chat y vuelve a soltar el archivo", "error");
      setAttachment(dropped);
      setFocus("composer");
      return;
    }
    if (focus === "list") return setQuery((q) => q + text.replace(/\s+/g, " "));
    setFocus("composer");
    setEditor((e) => ed.insert(e, text));
  });

  // ── render ───────────────────────────────────────────────
  if (s.link.phase !== "ready") {
    return (
      <Box flexDirection="column" width={columns} height={rows}>
        <LinkScreen link={s.link} width={columns} height={rows - 1} />
        <StatusBar link={s.link} busy={null} notice={s.notice} hints="Ctrl+C ×2 salir" width={columns} />
      </Box>
    );
  }

  const hints = overlay ? "" : HINTS[focus];
  return (
    <Box flexDirection="column" width={columns} height={rows} backgroundColor={theme.bg}>
      <Box height={bodyH}>
        {showList ? (
          <ChatList
            chats={filtered}
            selectedJid={focus === "list" ? selJid : s.openJid}
            openJid={s.openJid}
            width={listW}
            height={bodyH}
            query={query}
            searching={focus === "list" && query.length > 0}
            focused={focus === "list"}
            loaded={s.chatsLoaded}
            now={now}
          />
        ) : null}
        {showConvo ? (
          openChat ? (
            <Box flexDirection="column" width={convW} height={bodyH}>
              <ChatHeader chat={openChat} convo={convo} width={convW} />
              <Messages lines={visible} width={convW} height={msgsH} loadingOlder={!!convo?.loadingOlder} atTop={atTop} empty={!convo?.loading && (convo?.messages.length ?? 0) === 0} />
              <Composer editor={editor} attachment={attachment} focused={focus === "composer"} width={convW} />
            </Box>
          ) : (
            <Welcome width={convW} height={bodyH} />
          )
        ) : null}
      </Box>
      <StatusBar link={s.link} busy={s.busy} notice={s.notice} hints={hints} width={columns} />
      {s.banner && !overlay ? <BannerToast banner={s.banner} width={columns} /> : null}
      {overlay === "palette" ? <Palette query={palette.query} items={paletteItems} index={palette.index} width={columns} height={rows} /> : null}
      {overlay === "help" ? <HelpOverlay width={columns} height={rows} /> : null}
      {overlay === "attach" ? <AttachDialog value={attach.value} suggestions={attach.suggestions} error={attach.error} width={columns} /> : null}
    </Box>
  );
}

/** Empty right pane before any chat is opened — WhatsApp Web's splash. */
function Welcome({ width, height }: { width: number; height: number }) {
  return (
    <Box width={width} height={height} flexDirection="column" justifyContent="center" alignItems="center" backgroundColor={theme.bg}>
      <Text color={theme.accent} bold>◉ wacon</Text>
      <Text color={theme.text}>WhatsApp en tu terminal</Text>
      <Text> </Text>
      <Text color={theme.muted}>Elige un chat con ↑↓ y ↵, o escribe para buscarlo.</Text>
      <Text color={theme.muted}>Ctrl+K salta a cualquier chat · ? muestra todos los atajos</Text>
      <Text> </Text>
      <Text color={theme.faint}>Tu historial se guarda solo en este equipo (~/.wacon).</Text>
    </Box>
  );
}
