import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Box, Text, useAnimation, useApp, useInput, usePaste, useWindowSize, type Key } from "ink";
import type { UltraController } from "../application/controller.js";
import type { AgentController, AgentState } from "../application/agent-controller.js";
import type { AgendaController, AgendaState } from "../application/agenda-controller.js";
import { agendaSummary } from "../domain/agenda.js";
import type { ChatSummary } from "../domain/chat.js";
import { AgendaView, flatItems } from "./components/AgendaView.js";
import { ContactPanel } from "./components/ContactPanel.js";
import { commitmentsFor, todayLines, type ContactInfo } from "../domain/contact.js";
import type { ContactInfoPort } from "../application/ports.js";
import { HOME, HOME_ACTIONS, matchQuickActions, QUICK_ACTIONS, type QuickAction } from "../domain/agent.js";
import { AgentPanel, AgentPicker, PermissionDialog } from "./components/AgentPanel.js";
import type { ClipboardPort, FilePort, ImagePort, SearchHit } from "../application/ports.js";
import { colorIndex, matchesQuery } from "../domain/chat.js";
import { commonPrefix, parseDroppedPath } from "../domain/input.js";
import { excerpt, isOpenable, summarizeReactions } from "../domain/message.js";
import { buildTimeline } from "../domain/timeline.js";
import { layoutConversation, type QuotePreview } from "./layout.js";
import * as ed from "./editor.js";
import { resolveTheme, ThemeProvider, useTheme } from "./themes.js";
import { ChatList } from "./components/ChatList.js";
import { ChatHeader, Composer, Messages, composerHeight } from "./components/Conversation.js";
import { AppearanceDialog, APPEARANCE_ROWS, AttachDialog, BannerToast, HelpOverlay, Palette, StatusBar, type PaletteItem } from "./components/Chrome.js";
import { LinkScreen } from "./components/LinkScreen.js";
import { healthWarning } from "../domain/health.js";
import { ImageViewer } from "./components/ImageViewer.js";
import { ActionsMenu, QUICK_REACTIONS, ReactionPicker, SearchDialog, StickerDialog, type MessageAction } from "./components/Dialogs.js";

/**
 * Root view. Owns only UI state (focus, scroll, overlays, the text being
 * typed); everything about WhatsApp lives in the controller. All keys go
 * through ONE router below, so there is never a question of which widget
 * swallowed a keystroke — the bug class that made the old UI feel stuck.
 */

type Focus = "list" | "composer" | "messages" | "agent" | "agenda";
type Overlay = null | "palette" | "help" | "attach" | "appearance" | "search" | "sticker" | "actions" | "react" | "viewer" | "agents";

const HINTS: Record<Focus, string> = {
  list: "↑↓ elegir · ↵ abrir · escribe para buscar · ^K ir a… · ? ayuda",
  agenda: "↑↓ elegir · d hecho · Supr cancelar · n nueva tarea · i buscar fechas con IA · Esc volver",
  composer: "↵ enviar · ⇧↵ línea · ^O adjuntar · ↑ mensajes · Alt+I info · Esc chats · ^K ir a…",
  messages: "↑↓ elegir · ↵ acciones · r responder · e reaccionar · o abrir · c copiar · a preguntar a la IA · Esc",
  agent: "↵ preguntar · / acciones · ^L agente/modelo · Alt+T pensamiento · Esc volver",
};

const printable = (input: string, key: Key) => input.length > 0 && !key.ctrl && !key.meta && !key.escape && !key.return && !key.tab && !/[\x00-\x1f\x7f]/.test(input);

const NO_IMAGES: ImagePort = { available: false, draw: async () => undefined, release: () => undefined };
const NO_AGENT_STATE: AgentState = { catalog: { phase: "idle", agents: [] }, models: {}, busyJid: null, chats: {}, permission: null };
const noAgentSubscribe = () => () => undefined;
const noAgentState = () => NO_AGENT_STATE;
const NO_AGENDA_STATE: AgendaState = { phase: "idle", data: { events: [], tasks: [], staleSuggestions: 0, commitments: [] } };
const noAgendaState = () => NO_AGENDA_STATE;

/** Wacon's own rows at the top of the chat list (not WhatsApp chats). */
const special = (id: "home" | "agenda" | "archived" | "back", over: Partial<ChatSummary>): ChatSummary => ({
  jid: `wacon:${id}`, aliases: [], name: "", isGroup: false, unread: 0, lastTs: 0, preview: null, special: id === "back" ? "archived" : id, ...over,
});

export function App({ controller, files, clipboard, images = NO_IMAGES, agent, agenda, contacts }: { controller: UltraController; files: FilePort; clipboard?: ClipboardPort; images?: ImagePort; agent?: AgentController; agenda?: AgendaController; contacts?: ContactInfoPort }) {
  const s = useSyncExternalStore(controller.subscribe, controller.getState);
  const ai = useSyncExternalStore(agent?.subscribe ?? noAgentSubscribe, agent?.getState ?? noAgentState);
  const ag = useSyncExternalStore(agenda?.subscribe ?? noAgentSubscribe, agenda?.getState ?? noAgendaState);
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
  const [appearanceIdx, setAppearanceIdx] = useState(0);
  const [actionIdx, setActionIdx] = useState(0);
  const [viewer, setViewer] = useState<{ ids: string[]; index: number; data: Uint8Array | null; failed: boolean }>({ ids: [], index: 0, data: null, failed: false });
  const [reactIdx, setReactIdx] = useState(0);
  // The message being answered. A ref too, for the same fast-typing reason as the editor.
  const [replyTo, setReplyToState] = useState<string | null>(null);
  const replyRef = useRef<string | null>(null);
  const setReplyTo = (id: string | null) => {
    replyRef.current = id;
    setReplyToState(id);
  };
  const [search, setSearch] = useState<{ query: string; hits: SearchHit[]; index: number; loading: boolean }>({ query: "", hits: [], index: 0, loading: false });
  const [sticker, setSticker] = useState<{ moods: string[]; index: number }>({ moods: [], index: 0 });
  const quitArmedAt = useRef(0);
  // ── Modo IA (UI state only; the conversation lives in AgentController) ──
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentInput, setAgentInputState] = useState<ed.EditorState>({ text: "", cursor: 0 });
  const agentInputRef = useRef(agentInput);
  const setAgentInput = (next: ed.EditorState | ((e: ed.EditorState) => ed.EditorState)) => {
    agentInputRef.current = typeof next === "function" ? next(agentInputRef.current) : next;
    setAgentInputState(agentInputRef.current);
  };
  const [menuIdx, setMenuIdx] = useState(0);
  const [pickerIdx, setPickerIdx] = useState(0);
  // With no chat open, the right pane shows the AI home or the Agenda.
  const [pane, setPane] = useState<"home" | "agenda">("home");
  const [archivedMode, setArchivedMode] = useState(false);
  const [agendaIdx, setAgendaIdx] = useState(0);
  const [newTask, setNewTask] = useState<string | null>(null);
  // Alt+I: what Wacon knows about the open chat (local data, no tokens).
  const [info, setInfo] = useState<{ jid: string; data: ContactInfo | null; loading: boolean } | null>(null);
  /** Picker step 2: the agent whose models are listed. */
  const [pickerModelsFor, setPickerModelsFor] = useState<string | null>(null);

  const openChat = s.openJid ? (s.chats.find((c) => c.jid === s.openJid) ?? null) : null;
  const convo = s.openJid ? s.conversations[s.openJid] : undefined;
  // Theme changes apply live: every component reads it from context.
  const resolved = useMemo(() => resolveTheme(s.prefs), [s.prefs]);
  const theme = resolved.c;

  // ── geometry ─────────────────────────────────────────────
  // Below ~84 columns there is no room for two panes: behave like the phone
  // app — the list OR the conversation, Esc goes back.
  const narrow = columns < 84;
  const listW = narrow ? columns : Math.max(30, Math.min(48, Math.floor(columns * 0.34)));
  // The AI panel sits beside the chat when there is room (≥120 columns);
  // otherwise it takes the conversation pane while you talk to it.
  const panelVisible = agentOpen && !!agent && !!s.openJid;
  const panelSide = panelVisible && columns >= 120;
  const panelFull = panelVisible && !panelSide && focus === "agent";
  const restW = narrow ? columns : columns - listW;
  const panelW = panelSide ? Math.max(36, Math.min(58, Math.floor(restW * 0.42))) : restW;
  const convW = panelSide ? restW - panelW : restW;
  const bodyH = Math.max(4, rows - 1);
  const compH = composerHeight(editor, attachment, convW, !!replyTo);
  const msgsH = Math.max(1, bodyH - 1 - compH);
  const showList = !narrow || focus === "list" || !openChat;
  const showConvo = (!narrow || (focus !== "list" && !!openChat)) && !panelFull;

  // ── derived data ─────────────────────────────────────────
  const agendaSections = useMemo(() => (agenda ? agenda.sections() : []), [agenda, ag]);
  const archivedChats = useMemo(() => s.chats.filter((c) => c.archived), [s.chats]);
  const today = useMemo(() => {
    const todaySection = agendaSections.find((x) => x.label === "Hoy");
    const agendaToday = (todaySection?.items ?? []).map((i) => (i.kind === "event" ? `${new Date(i.startTs).toTimeString().slice(0, 5)} ${i.title}` : i.title));
    return todayLines({ unread: s.chats.filter((c) => !c.archived).map((c) => ({ name: c.name, unread: c.unread })), agendaToday, commitments: ag.data.commitments });
  }, [s.chats, agendaSections, ag.data.commitments]);
  const filtered = useMemo(() => {
    // Searching looks everywhere, archived included — like WhatsApp.
    if (query) return s.chats.filter((c) => matchesQuery(c, query));
    if (archivedMode) {
      return [special("back", { name: "← Volver a los chats", icon: "←", subtitle: `${archivedChats.length} chats archivados` }), ...archivedChats];
    }
    const rows: ChatSummary[] = [];
    if (agent) {
      const a = agent.active();
      const m = a ? agent.modelOf(a.id) : null;
      const busy = ai.busyJid === HOME;
      rows.push(special("home", { name: "Wacon IA", icon: "✦", subtitle: a ? `${a.name}${m ? ` · ${m.name}` : ""} · ${busy ? "trabajando…" : "pregúntale lo que quieras"}` : "elige tu agente de IA · Ctrl+L", meta: busy ? "…" : "" }));
    }
    if (agenda) {
      const pending = flatItems(agendaSections).length;
      rows.push(special("agenda", { name: "Agenda", icon: "📅", subtitle: agendaSummary(agendaSections, Date.now(), s.prefs.clock === "12h"), meta: pending ? String(pending) : "" }));
    }
    if (archivedChats.length) {
      const unread = archivedChats.reduce((n, c) => n + c.unread, 0);
      rows.push(special("archived", { name: "Archivados", icon: "🗄", subtitle: archivedChats.slice(0, 3).map((c) => c.name).join(", "), meta: String(archivedChats.length), unread }));
    }
    return [...rows, ...s.chats.filter((c) => !c.archived)];
  }, [s.chats, query, archivedMode, archivedChats, agent, ai.busyJid, ai.catalog, ai.models, agenda, agendaSections, s.prefs.clock, s.prefs.agent, s.prefs.agentModels]);
  const selJid = filtered.some((c) => c.jid === selectedJid) ? selectedJid : (filtered[0]?.jid ?? null);

  // New arrivals glow for ~2 s; animate only while something is glowing.
  const flashing = !!convo?.messages.some((m) => m.arrivedAt && Date.now() - m.arrivedAt < 2200);
  useAnimation({ interval: 250, isActive: flashing });
  const now = Date.now();

  // Reactions are stored individually and grouped here into WhatsApp's pills.
  const messagesWithReactions = useMemo(() => {
    if (!convo) return [];
    const pills = summarizeReactions(convo.reactions);
    return pills.size === 0 ? convo.messages : convo.messages.map((m) => (pills.has(m.id) ? { ...m, reactions: pills.get(m.id) } : m));
  }, [convo]);
  const timeline = useMemo(() => (convo ? buildTimeline(messagesWithReactions, now, convo.unreadAtOpen) : []), [convo, messagesWithReactions, now]);
  const msgIds = useMemo(() => timeline.flatMap((t) => (t.type === "msg" ? [t.msg.id] : [])), [timeline]);
  // Quote blocks resolve against what is loaded plus what the controller
  // fetched specifically for quotes that point further back.
  const quote = useMemo(() => {
    const byId = new Map((convo?.messages ?? []).map((m) => [m.id, m]));
    return (id: string): QuotePreview | null => {
      const q = byId.get(id) ?? convo?.quoted[id];
      if (!q) return null;
      const sender = q.fromMe ? "Tú" : openChat?.isGroup ? (q.senderJid && convo?.memberNames[q.senderJid]) || "~" : (openChat?.name ?? "");
      return { sender, text: excerpt(q), colorKey: q.fromMe ? null : q.senderJid };
    };
  }, [convo, openChat?.isGroup, openChat?.name]);
  // With no chat open the AI works over the whole WhatsApp: the home scope.
  const scopeJid = s.openJid ?? HOME;
  const homeMode = !!agent && !s.openJid && pane === "home";
  const agentChat = agent ? (ai.chats[scopeJid] ?? null) : null;
  const agentRead = useMemo(() => (panelVisible && agentChat?.readIds.length ? new Set(agentChat.readIds) : undefined), [panelVisible, agentChat?.readIds]);
  const view = useMemo(
    () => layoutConversation(timeline, { width: convW - 2, isGroup: !!openChat?.isGroup, memberNames: convo?.memberNames ?? {}, selectedId: focus === "messages" ? selMsg : null, now, theme: resolved, quote, agentRead }),
    [timeline, convW, openChat?.isGroup, convo?.memberNames, focus, selMsg, now, resolved, quote, agentRead]
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

  // Search as you type, debounced so each keystroke is not a daemon query.
  useEffect(() => {
    if (overlay !== "search") return;
    const q = search.query;
    if (q.trim().length < 2) {
      setSearch((x) => ({ ...x, hits: [], index: 0, loading: false }));
      return;
    }
    setSearch((x) => ({ ...x, loading: true }));
    let alive = true;
    const t = setTimeout(() => {
      void controller.searchConversation(q).then((hits) => {
        if (alive) setSearch((x) => (x.query === q ? { ...x, hits, index: 0, loading: false } : x));
      });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [search.query, overlay, controller]);

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
  /** Leave the open chat (keeping its draft) to show Wacon's own panes. */
  useEffect(() => {
    if (info && info.jid !== s.openJid) setInfo(null);
  }, [s.openJid, info]);

  const leaveChat = () => {
    if (s.openJid) controller.setDraft(s.openJid, editorRef.current.text);
    controller.closeChat();
    setAgentOpen(false);
  };
  const openSpecial = (jid: string): boolean => {
    if (jid === "wacon:home") {
      leaveChat();
      setPane("home");
      setSelectedJid(jid);
      if (agent?.active()) setFocus("agent");
      else if (agent) openAgentPicker();
      return true;
    }
    if (jid === "wacon:agenda") {
      leaveChat();
      setPane("agenda");
      setSelectedJid(jid);
      setAgendaIdx(0);
      void agenda?.refresh();
      setFocus("agenda");
      return true;
    }
    if (jid === "wacon:archived") {
      setArchivedMode(true);
      setSelectedJid(null);
      return true;
    }
    if (jid === "wacon:back") {
      setArchivedMode(false);
      setSelectedJid("wacon:archived");
      return true;
    }
    return false;
  };

  const switchTo = (jid: string, nextFocus: Focus = "composer") => {
    if (openSpecial(jid)) return;
    if (s.openJid) controller.setDraft(s.openJid, editorRef.current.text);
    if (jid !== s.openJid) {
      const draft = controller.getState().drafts[jid] ?? "";
      setEditor(ed.fromText(draft));
      setAttachment(null);
      setReplyTo(null);
      setScroll(0);
      setSelMsg(null);
      void controller.openChat(jid);
    }
    setSelectedJid(jid);
    setFocus(nextFocus);
  };

  const step = (dir: 1 | -1) => {
    const chats = filtered.filter((c) => !c.special);
    if (chats.length === 0) return;
    const base = s.openJid ?? selJid;
    const i = chats.findIndex((c) => c.jid === base);
    const next = chats[(i + dir + chats.length) % chats.length]!;
    switchTo(next.jid, focus === "list" ? "list" : "composer");
  };

  const send = () => {
    if (!openChat) return;
    const text = editorRef.current.text.trim();
    const file = attachmentRef.current;
    // Slash commands for things that are not plain text.
    const voice = /^\/voz\s+([\s\S]+)/i.exec(text);
    const stick = /^\/sticker\s*(\S*)/i.exec(text);
    if (!file && voice) {
      void controller.sendVoice(voice[1]!);
    } else if (!file && stick) {
      if (stick[1]) void controller.sendSticker(stick[1].toLowerCase());
      else openStickers();
    } else if (file) {
      void controller.sendFile(file, text || undefined);
      setAttachment(null);
    } else if (text) {
      void controller.sendText(text, replyRef.current ?? undefined);
    } else return;
    setReplyTo(null);
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
      { id: "a:search", label: "Buscar en esta conversación", hint: "Ctrl+F", kind: "action" },
      { id: "a:sticker", label: "Enviar sticker", hint: "Ctrl+S", kind: "action" },
      { id: "a:voice", label: "Enviar el borrador como nota de voz", hint: "/voz …", kind: "action" },
      ...(agent
        ? [
            { id: "a:ai", label: "Modo IA: preguntar sobre este chat", hint: "Ctrl+A", kind: "action" },
            { id: "a:ai-pick", label: "Modo IA: elegir agente (Claude, Codex, Gemini…)", kind: "action" },
            { id: "a:ai-reset", label: "Modo IA: empezar de cero en este chat", kind: "action" },
          ]
        : []),
      ...(agenda ? [{ id: "a:agenda", label: "Abrir la agenda (eventos y tareas)", kind: "action" as const }] : []),
      ...(contacts ? [{ id: "a:info", label: "Lo que Wacon sabe de este chat", hint: "Alt+I", kind: "action" as const }] : []),
      { id: "a:appearance", label: "Personalizar apariencia (tema, burbujas…)", hint: "Ctrl+T", kind: "action" },
      { id: "a:reload", label: "Recargar chats", kind: "action" },
      { id: "a:help", label: "Ver atajos de teclado", hint: "?", kind: "action" },
      { id: "a:quit", label: "Salir de Wacon", hint: "Ctrl+C ×2", kind: "action" },
    ].filter((a) => !palette.query || a.label.toLowerCase().includes(palette.query.toLowerCase())) as PaletteItem[];
    const chats = s.chats
      .filter((c) => matchesQuery(c, palette.query))
      .slice(0, 40)
      .map<PaletteItem>((c) => ({ id: `c:${c.jid}`, label: c.name, hint: c.unread ? `${c.unread} sin leer` : c.isGroup ? "grupo" : "", kind: "chat" }));
    return palette.query ? [...chats, ...actions] : [...actions.slice(0, 3), ...chats, ...actions.slice(3)];
  }, [palette.query, s.chats, agent, agenda, contacts]);

  const openSearch = () => {
    if (!openChat) return controller.inform("Abre un chat para buscar dentro de él");
    setSearch({ query: "", hits: [], index: 0, loading: false });
    setOverlay("search");
  };
  const openStickers = () => {
    if (!openChat) return controller.inform("Abre un chat para enviar un sticker");
    setSticker((x) => ({ ...x, index: 0 }));
    setOverlay("sticker");
    void controller.stickerMoods().then((moods) => setSticker((x) => ({ ...x, moods })));
  };
  const jumpToHit = (h: SearchHit | undefined) => {
    setOverlay(null);
    if (!h) return;
    void controller.jumpTo(h.id, h.ts).then((ok) => {
      if (!ok) return;
      setSelMsg(h.id);
      setFocus("messages");
    });
  };

  const selected = selMsg ? messagesWithReactions.find((m) => m.id === selMsg) : undefined;
  const actions: MessageAction[] = !selected
    ? []
    : [
        ...(selected.status === "failed" ? [{ key: "t", label: "Reintentar envío", id: "retry" as const }] : []),
        ...(selected.id.startsWith("local-") ? [] : [{ key: "r", label: "Responder", id: "reply" as const }, { key: "e", label: "Reaccionar", id: "react" as const }]),
        ...(isOpenable(selected.kind) ? [{ key: "o", label: "Abrir adjunto", id: "open" as const }] : []),
        ...(selected.text ? [{ key: "c", label: "Copiar texto", id: "copy" as const }] : []),
      ];
  const runAction = (id: MessageAction["id"] | undefined) => {
    setOverlay(null);
    if (!id || !selected) return;
    if (id === "reply") {
      setReplyTo(selected.id);
      setFocus("composer");
    } else if (id === "react") {
      const mine = selected.reactions?.find((r) => r.mine)?.emoji ?? null;
      setReactIdx(Math.max(0, QUICK_REACTIONS.indexOf(mine ?? "")));
      setOverlay("react");
    } else if (id === "open") openViewerOrSystem(selected.id);
    else if (id === "retry") void controller.retry(selected.id);
    else if (id === "copy") {
      if (clipboard) {
        clipboard.copy(selected.text);
        controller.inform("Copiado al portapapeles", "success");
      } else controller.inform("Tu terminal no permite copiar desde aquí");
    }
  };
  /** Photos/stickers open inside the terminal when it can draw them. */
  const viewable = (k: string) => k === "image" || k === "sticker";
  const showImage = (ids: string[], index: number) => {
    const id = ids[index];
    if (!id) return;
    setViewer({ ids, index, data: null, failed: false });
    void controller.loadImage(id).then((data) =>
      setViewer((v) => (v.ids[v.index] === id ? { ...v, data, failed: !data } : v))
    );
  };
  const openViewerOrSystem = (messageId: string) => {
    const m = messagesWithReactions.find((x) => x.id === messageId);
    if (!m) return;
    if (images.available && s.prefs.images === "terminal" && viewable(m.kind)) {
      const ids = messagesWithReactions.filter((x) => viewable(x.kind) && !x.id.startsWith("local-")).map((x) => x.id);
      setOverlay("viewer");
      showImage(ids, Math.max(0, ids.indexOf(messageId)));
      return;
    }
    void controller.openMedia(messageId);
  };

  const replyPreview = (() => {
    if (!replyTo) return null;
    const q = quote(replyTo);
    if (!q) return { sender: "Mensaje", text: "", color: theme.accentSoft };
    return { sender: q.sender, text: q.text, color: q.colorKey ? theme.people[colorIndex(q.colorKey, theme.people.length)]! : theme.accentSoft };
  })();

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
    if (it.id === "a:appearance") return setOverlay("appearance");
    if (it.id === "a:search") return openSearch();
    if (it.id === "a:sticker") return openStickers();
    if (it.id === "a:voice") {
      const draft = editorRef.current.text.trim();
      if (!draft) return controller.inform("Escribe primero lo que quieres decir");
      setEditor({ text: "", cursor: 0 });
      return void controller.sendVoice(draft);
    }
    if (it.id === "a:agenda") return void openSpecial("wacon:agenda");
    if (it.id === "a:info") return toggleInfo();
    if (it.id === "a:ai") return toggleAgent();
    if (it.id === "a:ai-pick") return openAgentPicker();
    if (it.id === "a:ai-reset") {
      if (agent && s.openJid) agent.reset(s.openJid);
      return controller.inform("Conversación con la IA reiniciada para este chat");
    }
    if (it.id === "a:help") return setOverlay("help");
    if (it.id === "a:quit") return quit();
  };

  // ── Modo IA ──────────────────────────────────────────────
  const menuOpen = focus === "agent" && agentInput.text.startsWith("/");
  const menuItems: QuickAction[] = menuOpen ? matchQuickActions(agentInput.text, homeMode ? [...HOME_ACTIONS, QUICK_ACTIONS.find((a) => a.picker)!] : QUICK_ACTIONS) : [];

  useEffect(() => {
    if (!agenda) return;
    void agenda.refresh();
    const t = setInterval(() => void agenda.refresh(), 60_000);
    return () => clearInterval(t);
  }, [agenda]);

  // The agent list is cheap (cached 24 h): load it at start so home shows who is ready.
  useEffect(() => {
    if (!agent) return;
    void agent.detect().then(() => {
      const a = agent.active();
      if (a && a.protocol !== "acp") void agent.loadModels(a.id); // ACP lists need a session: on demand
    });
  }, [agent]);

  /** Ctrl+A: open the panel (picking an agent the first time), or close it. */
  const toggleAgent = () => {
    if (!agent) return;
    if (panelVisible && focus === "agent") {
      setAgentOpen(false);
      return setFocus(openChat ? "composer" : "list");
    }
    if (!agent.active()) return openAgentPicker();
    if (openChat) setAgentOpen(true);
    else setPane("home");
    setFocus("agent");
  };
  const openAgentPicker = () => {
    if (!agent) return;
    setPickerIdx(0);
    setPickerModelsFor(null);
    setOverlay("agents");
    void agent.detect().then(() => {
      const i = agent.getState().catalog.agents.findIndex((a) => a.id === controller.getState().prefs.agent);
      setPickerIdx(Math.max(0, i));
    });
  };
  const chooseAgent = (id: string | undefined, modelId?: string | null) => {
    setOverlay(null);
    setPickerModelsFor(null);
    if (!agent || !id) return;
    agent.choose(id, modelId);
    if (openChat) setAgentOpen(true);
    setFocus("agent");
  };
  const openModels = (id: string | undefined) => {
    if (!agent || !id) return;
    setPickerModelsFor(id);
    const chosen = controller.getState().prefs.agentModels[id] ?? "";
    const st = agent.getState().models[id];
    setPickerIdx(chosen && st ? Math.max(0, st.list.findIndex((m) => m.id === chosen) + 1) : 0);
    void agent.loadModels(id);
  };
  const askAgent = (text: string, action: QuickAction | null = null) => {
    if (!agent) return;
    setAgentInput({ text: "", cursor: 0 });
    setMenuIdx(0);
    void agent.ask(text, action, selMsg);
  };
  const runQuickAction = (a: QuickAction | undefined) => {
    if (!a) return;
    if (a.picker) {
      setAgentInput({ text: "", cursor: 0 });
      return openAgentPicker();
    }
    if (a.needsSelection && !selMsg) {
      setAgentInput({ text: "", cursor: 0 });
      return controller.inform("Selecciona primero un mensaje (↑ desde el compositor) y pulsa a");
    }
    // "Buscar…" needs your words: leave the prompt ready to complete.
    if (a.needsText) return setAgentInput(ed.fromText(a.prompt));
    askAgent(a.prompt, a);
  };
  const takeDraft = () => {
    if (!agent) return;
    const d = agent.takeDraft(scopeJid);
    if (!d) return;
    // A home draft names its chat: open it with the draft in the composer.
    if (homeMode) {
      const target = d.chatJid ? controller.findChat(d.chatJid) : null;
      if (!target) return controller.inform("No encontré el chat de ese borrador", "error");
      switchTo(target.jid);
    }
    setEditor(ed.fromText(d.text));
    if (d.replyTo) setReplyTo(d.replyTo);
    setFocus("composer");
  };

  const toggleInfo = () => {
    if (!openChat || !contacts) return controller.inform("Abre un chat para ver lo que Wacon sabe de él");
    if (info?.jid === openChat.jid) return setInfo(null);
    const jid = openChat.jid;
    setInfo({ jid, data: null, loading: true });
    void contacts
      .contactInfo(jid)
      .then((data) => setInfo((x) => (x?.jid === jid ? { jid, data, loading: false } : x)))
      .catch(() => setInfo((x) => (x?.jid === jid ? { jid, data: null, loading: false } : x)));
  };

  const handleAgenda = (input: string, key: Key) => {
    if (!agenda) return setFocus("list");
    const items = flatItems(agendaSections);
    if (newTask !== null) {
      if (key.escape) return setNewTask(null);
      if (key.return) {
        const t = newTask;
        setNewTask(null);
        return void agenda.addTask(t);
      }
      if (key.backspace || key.delete) return setNewTask((x) => (x ?? "").slice(0, -1));
      if (printable(input, key)) setNewTask((x) => (x ?? "") + input);
      return;
    }
    if (key.escape || key.tab || key.leftArrow) return setFocus("list");
    if (key.upArrow) return setAgendaIdx((i) => Math.max(0, i - 1));
    if (key.downArrow) return setAgendaIdx((i) => Math.min(Math.max(0, items.length - 1), i + 1));
    const item = items[Math.min(agendaIdx, items.length - 1)];
    if (input === "d" && item) return void agenda.complete(item);
    if (key.delete && item) return void agenda.cancel(item);
    if (input === "n") return setNewTask("");
    if (input === "x" && ag.data.staleSuggestions) return void agenda.clearStale();
    if (input === "i" && agent) {
      if (!agent.active()) return openAgentPicker();
      setPane("home");
      setFocus("agent");
      return runQuickAction(HOME_ACTIONS.find((a) => a.id === "fechas"));
    }
  };

  /** ↵ on a proposal card: the user's decision to add it to the agenda. */
  const acceptProposal = () => {
    if (!agent || !agenda) return;
    const p = agent.takeProposal(scopeJid);
    if (p) void agenda.add(p);
  };

  const handleAgent = (input: string, key: Key) => {
    if (!agent) return setFocus("list");
    const jid = scopeJid;
    const draft = agentChat?.draft ?? null;
    const empty = !agentInputRef.current.text;
    const back = () => setFocus(homeMode ? "list" : "composer");
    if (key.escape) {
      if (ai.busyJid === jid) return agent.cancel();
      if (menuOpen) return setAgentInput({ text: "", cursor: 0 });
      if (draft) return void agent.takeDraft(jid);
      if (agentChat?.proposals.length) return void agent.takeProposal(jid);
      return back();
    }
    // Home cards are one key away.
    if (homeMode && empty && /^[1-9]$/.test(input)) return runQuickAction(HOME_ACTIONS[Number(input) - 1]);
    if (menuOpen) {
      const n = menuItems.length;
      if (key.upArrow) return setMenuIdx((i) => (i - 1 + n) % Math.max(1, n));
      if (key.downArrow || key.tab) return setMenuIdx((i) => (i + 1) % Math.max(1, n));
      if (key.return) return runQuickAction(menuItems[Math.min(menuIdx, n - 1)]);
    }
    if (key.tab) return draft ? takeDraft() : back();
    const newline = (key.return && (key.shift || key.meta)) || (key.ctrl && input === "j");
    if (newline) return setAgentInput((e) => ed.insert(e, "\n"));
    if (key.return) {
      if (empty && draft) return homeMode ? takeDraft() : void agent.sendDraft(jid);
      if (empty && agentChat?.proposals.length) return acceptProposal();
      const text = agentInputRef.current.text.trim();
      if (text) askAgent(text);
      return;
    }
    if (key.backspace) return setAgentInput((e) => (key.ctrl || key.meta ? ed.deleteWordBack(e) : ed.backspace(e)));
    if (key.delete) return setAgentInput(ed.del);
    if (key.leftArrow) return setAgentInput((e) => (key.ctrl || key.meta ? ed.wordLeft(e) : ed.left(e)));
    if (key.rightArrow) return setAgentInput((e) => (key.ctrl || key.meta ? ed.wordRight(e) : ed.right(e)));
    if (key.home) return setAgentInput(ed.home);
    if (key.end || (key.ctrl && input === "e")) return setAgentInput(ed.end);
    if (key.ctrl && input === "u") return setAgentInput(ed.deleteToLineStart);
    if (printable(input, key)) {
      if (input === "/" && empty) setMenuIdx(0);
      setAgentInput((e) => ed.insert(e, input));
    }
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

    // An agent waiting on a permission answer outranks everything else.
    if (agent && ai.permission) {
      const n = ai.permission.options.length;
      const digit = /^[1-9]$/.test(input) ? Number(input) - 1 : -1;
      if (key.escape) {
        const reject = ai.permission.options.find((o) => o.kind.startsWith("reject"));
        return agent.answerPermission(reject?.id ?? null);
      }
      if (digit >= 0 && digit < n) return agent.answerPermission(ai.permission.options[digit]!.id);
      return;
    }
    if (overlay === "agents") {
      const list = ai.catalog.agents;
      const n = list.length;
      if (key.escape) return setOverlay(null);
      if (pickerModelsFor) {
        const rows = 1 + (ai.models[pickerModelsFor]?.list.length ?? 0);
        if (key.leftArrow || key.backspace) {
          setPickerIdx(Math.max(0, list.findIndex((a) => a.id === pickerModelsFor)));
          return setPickerModelsFor(null);
        }
        if (key.upArrow) return setPickerIdx((i) => (i - 1 + rows) % rows);
        if (key.downArrow || key.tab) return setPickerIdx((i) => (i + 1) % rows);
        if (key.return) return chooseAgent(pickerModelsFor, pickerIdx === 0 ? null : (ai.models[pickerModelsFor]?.list[pickerIdx - 1]?.id ?? null));
        return;
      }
      if (input === "r") return void agent?.detect(true);
      if (input === "c") return agent?.togglePower();
      if (key.upArrow) return setPickerIdx((i) => (i - 1 + n) % Math.max(1, n));
      if (key.downArrow || key.tab) return setPickerIdx((i) => (i + 1) % Math.max(1, n));
      if (key.rightArrow || input === "m") return openModels(list[pickerIdx]?.id);
      if (key.return) return chooseAgent(list[pickerIdx]?.id);
      return;
    }

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
    if (overlay === "viewer") {
      if (key.escape || input === "q") return setOverlay(null);
      if (input === "v") {
        const id = viewer.ids[viewer.index];
        setOverlay(null);
        if (id) void controller.openMedia(id);
        return;
      }
      if (key.leftArrow && viewer.index > 0) return showImage(viewer.ids, viewer.index - 1);
      if (key.rightArrow && viewer.index < viewer.ids.length - 1) return showImage(viewer.ids, viewer.index + 1);
      return;
    }
    if (overlay === "actions") {
      const n = actions.length;
      if (key.escape) return setOverlay(null);
      if (key.upArrow) return setActionIdx((i) => (i - 1 + n) % Math.max(1, n));
      if (key.downArrow || key.tab) return setActionIdx((i) => (i + 1) % Math.max(1, n));
      if (key.return) return runAction(actions[actionIdx]?.id);
      const hot = actions.find((a) => a.key === input.toLowerCase());
      if (hot) return runAction(hot.id);
      return;
    }
    if (overlay === "react") {
      const n = QUICK_REACTIONS.length;
      if (key.escape) return setOverlay(null);
      if (key.leftArrow) return setReactIdx((i) => (i - 1 + n) % n);
      if (key.rightArrow || key.tab) return setReactIdx((i) => (i + 1) % n);
      const digit = /^[1-6]$/.test(input) ? Number(input) - 1 : -1;
      if (key.return || digit >= 0) {
        const emoji = QUICK_REACTIONS[digit >= 0 ? digit : reactIdx]!;
        setOverlay(null);
        if (selected) void controller.react(selected.id, emoji);
      }
      return;
    }
    if (overlay === "search") {
      const n = search.hits.length;
      if (key.escape) return setOverlay(null);
      if (key.return) return jumpToHit(search.hits[search.index]);
      if (key.upArrow) return setSearch((x) => ({ ...x, index: Math.max(0, x.index - 1) }));
      if (key.downArrow || key.tab) return setSearch((x) => ({ ...x, index: Math.min(Math.max(0, n - 1), x.index + 1) }));
      if (key.backspace || key.delete) return setSearch((x) => ({ ...x, query: x.query.slice(0, -1) }));
      if (printable(input, key)) return setSearch((x) => ({ ...x, query: x.query + input }));
      return;
    }
    if (overlay === "sticker") {
      const n = sticker.moods.length;
      const perRow = Math.max(1, Math.floor((Math.min(60, columns - 4) - 4) / 14));
      if (key.escape) return setOverlay(null);
      if (key.return && n) {
        setOverlay(null);
        return void controller.sendSticker(sticker.moods[sticker.index]!);
      }
      const move = (d: number) => setSticker((x) => ({ ...x, index: Math.max(0, Math.min(n - 1, x.index + d)) }));
      if (key.leftArrow) return move(-1);
      if (key.rightArrow || key.tab) return move(1);
      if (key.upArrow) return move(-perRow);
      if (key.downArrow) return move(perRow);
      return;
    }
    if (overlay === "appearance") {
      const n = APPEARANCE_ROWS.length;
      if (key.escape || key.return || (key.ctrl && input === "t")) return setOverlay(null);
      if (key.upArrow) return setAppearanceIdx((i) => (i - 1 + n) % n);
      if (key.downArrow || key.tab) return setAppearanceIdx((i) => (i + 1) % n);
      if (key.leftArrow || key.rightArrow || input === " ") {
        const row = APPEARANCE_ROWS[appearanceIdx]!;
        controller.setPreferences(row.next(s.prefs, key.leftArrow ? -1 : 1));
      }
      return;
    }

    // Global shortcuts (non-typable, so safe while composing).
    if (key.ctrl && input === "a") return toggleAgent();
    if (key.ctrl && input === "l") return openAgentPicker();
    if (key.meta && input === "i") return toggleInfo();
    if (info && key.escape && !overlay) return setInfo(null);
    // Alt+T: show or fold the agents' native reasoning.
    if (key.meta && input === "t" && agent) return controller.setPreferences({ showThinking: !s.prefs.showThinking });
    if (key.ctrl && input === "k") {
      setPalette({ query: "", index: 0 });
      return setOverlay("palette");
    }
    if ((key.ctrl && input === "n") || (key.meta && key.downArrow)) return step(1);
    if ((key.ctrl && input === "p") || (key.meta && key.upArrow)) return step(-1);
    if (key.ctrl && input === "g") return jumpToBanner();
    if (key.ctrl && input === "t") return setOverlay("appearance");
    if (key.ctrl && input === "f") return openSearch();
    if (key.ctrl && input === "s") return openStickers();
    if (key.ctrl && input === "o") return openAttach();
    if (key.ctrl && input === "r") return retryLast();
    if (openChat && (key.pageUp || key.pageDown)) {
      const pageSize = Math.max(1, msgsH - 2);
      return setScroll((v) => Math.max(0, Math.min(maxScroll, v + (key.pageUp ? pageSize : -pageSize))));
    }

    if (focus === "list") return handleList(input, key);
    if (focus === "messages") return handleMessages(input, key);
    if (focus === "agent") return handleAgent(input, key);
    if (focus === "agenda") return handleAgenda(input, key);
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
    if (key.escape) {
      if (query) return setQuery("");
      if (archivedMode) return openSpecial("wacon:back"), undefined;
      return;
    }
    if ((key.tab || key.rightArrow) && openChat) return setFocus("composer");
    if ((key.tab || key.rightArrow) && homeMode) return agent!.active() ? setFocus("agent") : openAgentPicker();
    if ((key.tab || key.rightArrow) && !s.openJid && pane === "agenda" && agenda) return setFocus("agenda");
    if (homeMode && !query && /^[1-9]$/.test(input) && agent!.active()) {
      setFocus("agent");
      return runQuickAction(HOME_ACTIONS[Number(input) - 1]);
    }
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
      setActionIdx(0);
      return setOverlay("actions");
    }
    // "a": ask the AI about this message.
    if (input === "a" && agent && !key.ctrl && !key.meta) {
      if (!agent.active()) return openAgentPicker();
      setAgentOpen(true);
      setFocus("agent");
      return setAgentInput({ text: "/", cursor: 1 });
    }
    // Single-letter shortcuts mirror the menu (r/e/o/c/t); anything else types.
    const hot = actions.find((a) => a.key === input);
    if (hot && !key.ctrl && !key.meta) return runAction(hot.id);
    // Typing jumps straight back into the composer with that character.
    if (printable(input, key)) {
      setFocus("composer");
      setEditor((e) => ed.insert(e, input));
    }
  };

  const handleComposer = (input: string, key: Key) => {
    // Esc first cancels a reply; otherwise back to the list, keeping the
    // draft — the phone's "back".
    if (key.escape) {
      if (replyRef.current) return setReplyTo(null);
      return setFocus("list");
    }
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
    if (key.home) return setEditor(ed.home);
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
    if (overlay === "search") return setSearch((x) => ({ ...x, query: x.query + text.replace(/\s+/g, " ") }));
    if (overlay) return;
    const dropped = parseDroppedPath(text);
    if (dropped && files.exists(dropped)) {
      if (!openChat) return controller.inform("Abre un chat y vuelve a soltar el archivo", "error");
      setAttachment(dropped);
      setFocus("composer");
      return;
    }
    if (focus === "list") return setQuery((q) => q + text.replace(/\s+/g, " "));
    if (focus === "agent") return setAgentInput((e) => ed.insert(e, text));
    setFocus("composer");
    setEditor((e) => ed.insert(e, text));
  });

  // ── render ───────────────────────────────────────────────
  if (s.link.phase !== "ready") {
    return (
      <ThemeProvider value={resolved}>
        <Box flexDirection="column" width={columns} height={rows}>
          <LinkScreen link={s.link} width={columns} height={rows - 1} />
          <StatusBar link={s.link} busy={null} notice={s.notice} hints="Ctrl+C ×2 salir" width={columns} />
        </Box>
      </ThemeProvider>
    );
  }

  const hints = overlay ? "" : HINTS[focus];
  return (
    <ThemeProvider value={resolved}>
    <Box flexDirection="column" width={columns} height={rows} backgroundColor={theme.bg}>
      <Box height={bodyH}>
        {showList ? (
          <ChatList
            chats={filtered}
            title={archivedMode && !query ? "Archivados" : "Chats"}
            selectedJid={focus === "list" ? selJid : (s.openJid ?? `wacon:${pane}`)}
            openJid={s.openJid ?? (agent || agenda ? `wacon:${pane}` : null)}
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
              <Composer editor={editor} attachment={attachment} focused={focus === "composer"} width={convW} replyTo={replyPreview} />
            </Box>
          ) : pane === "agenda" && agenda ? (
            <AgendaView
              sections={agendaSections}
              loading={ag.phase === "loading"}
              index={agendaIdx}
              focused={focus === "agenda"}
              staleSuggestions={ag.data.staleSuggestions}
              newTask={newTask}
              chatName={(jid) => controller.findChat(jid)?.name ?? null}
              hasAgent={!!agent?.active()}
              width={convW}
              height={bodyH}
            />
          ) : (
            agent ? (
              <AgentPanel
                home
                homeActions={HOME_ACTIONS}
                today={today}
                agent={agent.active()}
                model={agent.active() ? agent.modelOf(agent.active()!.id) : null}
                draftChatName={agentChat?.draft?.chatJid ? (controller.findChat(agentChat.draft.chatJid)?.name ?? null) : null}
                view={{ showThinking: s.prefs.showThinking, alternatives: agent.alternatives().map((a) => a.name) }}
                chatName="tu WhatsApp"
                state={agent.chat(HOME)}
                busy={ai.busyJid === HOME}
                focused={focus === "agent"}
                input={agentInput}
                menu={menuOpen ? { items: menuItems, index: Math.min(menuIdx, Math.max(0, menuItems.length - 1)) } : null}
                width={convW}
                height={bodyH}
              />
            ) : (
              <Welcome width={convW} height={bodyH} />
            )
          )
        ) : null}
        {agent && panelVisible && (panelSide || panelFull) ? (
          <AgentPanel
            agent={agent.active()}
            model={agent.active() ? agent.modelOf(agent.active()!.id) : null}
            view={{ showThinking: s.prefs.showThinking, alternatives: agent.alternatives().map((a) => a.name) }}
            chatName={openChat?.name ?? ""}
            state={agent.chat(s.openJid)}
            busy={ai.busyJid === s.openJid}
            focused={focus === "agent"}
            input={agentInput}
            menu={menuOpen ? { items: menuItems, index: Math.min(menuIdx, Math.max(0, menuItems.length - 1)) } : null}
            width={panelW}
            height={bodyH}
          />
        ) : null}
      </Box>
      <StatusBar link={s.link} busy={s.busy} notice={s.notice} hints={hints} width={columns} warning={healthWarning(s.health)} />
      {s.banner && !overlay ? <BannerToast banner={s.banner} width={columns} /> : null}
      {overlay === "palette" ? <Palette query={palette.query} items={paletteItems} index={palette.index} width={columns} height={rows} /> : null}
      {overlay === "help" ? <HelpOverlay width={columns} height={rows} /> : null}
      {overlay === "attach" ? <AttachDialog value={attach.value} suggestions={attach.suggestions} error={attach.error} width={columns} /> : null}
      {overlay === "search" ? (
        <SearchDialog
          query={search.query}
          hits={search.hits}
          index={search.index}
          loading={search.loading}
          width={columns}
          height={rows}
          now={now}
          names={(h) => (openChat?.isGroup ? (h.senderJid && convo?.memberNames[h.senderJid]) || "~" : (openChat?.name.split(" ")[0] ?? ""))}
        />
      ) : null}
      {overlay === "viewer" ? (
        <ImageViewer
          images={images}
          data={viewer.data}
          failed={viewer.failed}
          title={openChat?.name ?? "Foto"}
          position={viewer.ids.length > 1 ? `${viewer.index + 1}/${viewer.ids.length}` : ""}
          width={columns}
          height={bodyH}
        />
      ) : null}
      {overlay === "actions" && selected ? <ActionsMenu actions={actions} index={actionIdx} width={columns} preview={excerpt(selected) || "…"} /> : null}
      {overlay === "react" && selected ? <ReactionPicker index={reactIdx} width={columns} current={selected.reactions?.find((r) => r.mine)?.emoji ?? null} /> : null}
      {overlay === "sticker" ? <StickerDialog moods={sticker.moods} index={sticker.index} width={columns} /> : null}
      {info && openChat && contacts ? (
        <Box position="absolute" top={0} left={Math.max(0, columns - Math.min(56, Math.max(36, Math.floor(columns * 0.4))))}>
          <ContactPanel
            name={openChat.name}
            isGroup={openChat.isGroup}
            info={info.data}
            loading={info.loading}
            commitments={commitmentsFor(ag.data.commitments, [openChat.jid, ...openChat.aliases])}
            agenda={flatItems(agendaSections).filter((i) => !!i.chatJid && (i.chatJid === openChat.jid || openChat.aliases.includes(i.chatJid)))}
            hasAgent={!!agent?.active()}
            width={Math.min(56, Math.max(36, Math.floor(columns * 0.4)))}
            height={bodyH}
          />
        </Box>
      ) : null}
      {overlay === "agents" ? (
        <AgentPicker
          phase={ai.catalog.phase}
          agents={ai.catalog.agents}
          activeId={s.prefs.agent}
          index={pickerIdx}
          width={columns}
          modelsFor={pickerModelsFor ? (ai.catalog.agents.find((a) => a.id === pickerModelsFor) ?? null) : null}
          models={pickerModelsFor ? (ai.models[pickerModelsFor] ?? null) : null}
          chosenModel={pickerModelsFor ? (s.prefs.agentModels[pickerModelsFor] ?? null) : null}
          power={s.prefs.agentPower}
          quota={(id, model) => agent?.quotaFor(id, model)?.message ?? null}
        />
      ) : null}
      {agent && ai.permission ? <PermissionDialog request={ai.permission} agentName={agent.active()?.name ?? "El agente"} width={columns} /> : null}
      {overlay === "appearance" ? <AppearanceDialog index={appearanceIdx} width={columns} location={controller.preferencesLocation()} /> : null}
    </Box>
    </ThemeProvider>
  );
}

/** Empty right pane before any chat is opened — WhatsApp Web's splash. */
function Welcome({ width, height }: { width: number; height: number }) {
  const theme = useTheme().c;
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
