import type { ChatMessage } from "./message.js";
import { excerpt } from "./message.js";
import { clock } from "./time.js";
import { truncate } from "./text.js";

/**
 * "Modo IA": the user's own installed AI agents (Claude Code, Codex, Gemini…)
 * work on the chat that is open. Everything here is pure — how to talk to a
 * given CLI lives in infrastructure; what to tell it and how to show what it
 * does lives here.
 */

/** How Wacon speaks to an agent CLI. */
export type AgentProtocol = "acp" | "claude-stream" | "codex-json";

/** An agent found on this machine. */
export interface DetectedAgent {
  id: string;
  name: string;
  protocol: AgentProtocol;
  /** Absolute path of the executable. */
  command: string;
  version: string | null;
}

/** What a running agent reports, normalised across protocols. */
export type AgentEvent =
  | { type: "session"; sessionId: string }
  | { type: "text"; text: string }
  | { type: "thought"; text: string }
  | { type: "tool"; id: string; title: string; input?: unknown; status: "running" | "done" | "failed"; output?: string }
  | { type: "permission"; requestId: string; title: string; options: PermissionChoice[] }
  | { type: "usage"; inputTokens?: number; outputTokens?: number; costUsd?: number }
  | { type: "done"; stopReason?: string }
  | { type: "error"; message: string }
  /** The agent told us which models it offers (ACP session/new, config updates). */
  | { type: "models"; models: ModelOption[]; current: string | null };

/** One model an agent can run on. */
export interface ModelOption {
  id: string;
  name: string;
  description?: string;
}

export interface PermissionChoice {
  id: string;
  label: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

// ── tools ──────────────────────────────────────────────────

/** The reduced Wacon toolset an agent gets inside the app (`wacon mcp --toolset tui`). */
export const TUI_TOOLSET = [
  // the open chat, and every other one
  "list_chats",
  "resolve_contact",
  "read_messages",
  "search_messages",
  "find_links",
  // the day: what is new, pending, coming up
  "get_inbox",
  "get_briefing",
  "get_agenda",
  "recall_context",
  "list_episodes",
  "read_episode",
  "get_contact_profile",
  "get_contact_facts",
  "remember_fact",
  "get_persona",
  "prepare_reply",
  "get_commitments",
  "view_image",
  "transcribe_audio",
  "propose_reply",
  // the agenda: proposals the user accepts
  "propose_event",
  "propose_task",
] as const;
export type WaconTool = (typeof TUI_TOOLSET)[number];

/**
 * The MCP titles of those tools. Some agents (Copilot) show and ask about a
 * tool by its title — "List recent chats" — not its name. Kept in sync with
 * src/mcp/server.ts by a test.
 */
export const TOOL_TITLES: Record<WaconTool, string> = {
  propose_reply: "Propose a message for the user to send",
  propose_event: "Propose adding an event to the user's agenda",
  propose_task: "Propose adding a task to the user's list",
  list_chats: "List recent chats",
  read_messages: "Read messages from a chat",
  search_messages: "Full-text search in message history",
  find_links: "Find shared links and files across all chats",
  recall_context: "Hybrid memory recall (RAG)",
  list_episodes: "List conversation episodes",
  read_episode: "Read a full conversation episode",
  resolve_contact: "Resolve a name/number to the real chat",
  get_contact_profile: "Contact profile: facts + dynamics + style + tags",
  get_persona: "The user's global voice",
  remember_fact: "Store a fact about the person",
  get_contact_facts: "Facts known about the person + gaps",
  prepare_reply: "Assemble everything needed to reply authentically",
  view_image: "See an image from a chat",
  transcribe_audio: "Hear a voice note",
  get_inbox: "What still needs the user's reply",
  get_commitments: "Promises the user made and may not have kept",
  get_briefing: "Start-of-day briefing",
  get_agenda: "Current time + upcoming events & tasks",
};
const BY_TITLE = new Map(Object.entries(TOOL_TITLES).map(([k, v]) => [v.toLowerCase(), k as WaconTool]));

// A separator before the name may be "__" (Claude) or "." (Codex); after it, no more name characters.
const TOOL_RE = new RegExp(`(?:^|[^a-z])(${[...TUI_TOOLSET].sort((a, b) => b.length - a.length).join("|")})(?![a-z_])`);

/**
 * Agents name MCP tools their own way: "mcp__wacon__read_messages" (Claude),
 * "wacon.read_messages" (Codex), "read_messages (wacon MCP Server)" (Gemini).
 * This finds the Wacon tool inside any of them.
 */
export function waconTool(title: string): WaconTool | null {
  const low = title.trim().toLowerCase();
  const byTitle = BY_TITLE.get(low) ?? [...BY_TITLE.entries()].find(([t]) => low.startsWith(t))?.[1];
  if (byTitle) return byTitle;
  const m = TOOL_RE.exec(low);
  return (m?.[1] as WaconTool | undefined) ?? null;
}

const arg = (input: unknown, key: string): string | null => {
  if (!input || typeof input !== "object") return null;
  const v = (input as Record<string, unknown>)[key];
  return typeof v === "string" || typeof v === "number" ? String(v) : null;
};

/** What the user sees for a tool call: what the agent is doing, in plain words. */
export function toolLabel(title: string, input: unknown): string {
  const t = waconTool(title);
  const q = arg(input, "query");
  switch (t) {
    case "read_messages": {
      const n = arg(input, "limit");
      return `📖 Leyendo ${n ? `${n} mensajes` : "mensajes"}${arg(input, "before_timestamp") ? " anteriores" : ""}`;
    }
    case "search_messages":
      return `🔎 Buscando «${truncate(q ?? "…", 30)}»${arg(input, "chat") ? "" : " en todos tus chats"}`;
    case "find_links": {
      const kinds = (input && typeof input === "object" && Array.isArray((input as { kinds?: unknown }).kinds) ? ((input as { kinds: string[] }).kinds) : []).join(", ");
      return `🔗 Buscando enlaces${kinds ? ` (${kinds})` : ""}${arg(input, "chat") ? "" : " en todos tus chats"}`;
    }
    case "get_inbox":
      return "📥 Revisando qué te falta responder";
    case "get_briefing":
      return "🗞️  Preparando tu resumen";
    case "get_agenda":
      return "📅 Revisando tu agenda";
    case "list_chats":
      return "🗂️  Revisando tus chats";
    case "resolve_contact":
      return `👤 Buscando a «${truncate(q ?? "…", 24)}»`;
    case "recall_context":
      return `🧠 Recordando «${truncate(q ?? "…", 30)}»`;
    case "list_episodes":
    case "read_episode":
      return "📚 Revisando conversaciones pasadas";
    case "get_contact_profile":
      return "👤 Consultando el perfil del contacto";
    case "get_contact_facts":
      return "📌 Revisando lo que sé del contacto";
    case "remember_fact":
      return `💾 Guardando: ${truncate(arg(input, "fact") ?? "un dato", 40)}`;
    case "get_persona":
      return "✍️  Estudiando tu forma de escribir";
    case "prepare_reply":
      return "✍️  Preparando una respuesta";
    case "get_commitments":
      return "📋 Revisando pendientes";
    case "view_image":
      return "🖼️  Mirando una foto";
    case "transcribe_audio":
      return "🎧 Escuchando un audio";
    case "propose_reply":
      return "💬 Proponiendo un mensaje";
    case "propose_event":
      return `📅 Proponiendo: ${truncate(arg(input, "title") ?? "un evento", 40)}`;
    case "propose_task":
      return `☐ Proponiendo: ${truncate(arg(input, "title") ?? "una tarea", 40)}`;
    default:
      return `🔧 ${truncate(title.replace(/^mcp__\w+?__/, ""), 50)}`;
  }
}

/** A message the agent drafted for the user to send — never sent by the agent. */
export interface Draft {
  chatJid: string | null;
  text: string;
  replyTo: string | null;
}

export function draftFrom(title: string, input: unknown): Draft | null {
  if (waconTool(title) !== "propose_reply") return null;
  const text = arg(input, "text")?.trim();
  if (!text) return null;
  return { chatJid: arg(input, "chat"), text, replyTo: arg(input, "reply_to") };
}

/**
 * Which loaded messages a tool call put in front of the agent — they get a
 * mark in the conversation, so the user sees exactly what is being analysed.
 */
export function readIdsFrom(title: string, input: unknown, output: string | undefined, loaded: readonly ChatMessage[]): string[] {
  const tool = waconTool(title);
  if (!tool) return [];
  const known = new Set(loaded.map((m) => m.id));
  const ids = new Set<string>();
  // Results carry message ids; keep the ones on screen.
  for (const m of (output ?? "").matchAll(/"(?:id|message_id)"\s*:\s*"([^"]+)"/g)) if (known.has(m[1]!)) ids.add(m[1]!);
  const msgId = arg(input, "message_id");
  if (msgId && known.has(msgId)) ids.add(msgId);
  // read_messages without a readable result: it read the newest `limit`.
  if (tool === "read_messages" && ids.size === 0 && !arg(input, "before_timestamp")) {
    const n = Math.min(200, Number(arg(input, "limit") ?? 30) || 30);
    for (const m of loaded.slice(-n)) ids.add(m.id);
  }
  return [...ids];
}

// ── context ────────────────────────────────────────────────

export interface CapsuleInput {
  chatJid: string;
  chatName: string;
  isGroup: boolean;
  isSelf: boolean;
  unread: number;
  messages: readonly ChatMessage[];
  memberNames: Record<string, string>;
  selected: ChatMessage | null;
}

/** ~4 chars per token: 6000 chars ≈ 1.5k tokens, enough for the recent thread. */
export const CAPSULE_BUDGET = 6000;

const who = (m: ChatMessage, c: CapsuleInput) =>
  m.fromMe ? "Tú" : c.isGroup ? (m.senderJid && c.memberNames[m.senderJid]) || "~" : c.chatName.split(" ")[0] || c.chatName;

const lineOf = (m: ChatMessage, c: CapsuleInput) => `${clock(m.ts)} ${who(m, c)}: ${truncate(excerpt(m) || "…", 200)}`;

/**
 * The context an agent starts from: who the chat is with and the recent
 * thread, compacted, newest kept first when the budget runs out. Never the
 * whole history — the agent fetches more through the tools only if it needs
 * to, which is what keeps a question cheap.
 */
export function buildContextCapsule(c: CapsuleInput, budget = CAPSULE_BUDGET): { text: string; includedIds: string[] } {
  const head = [
    `chat: ${c.chatName} (${c.isSelf ? "tus notas personales" : c.isGroup ? "grupo" : "1 a 1"}) · id ${c.chatJid}`,
    c.unread > 0 ? `sin leer: ${c.unread}` : null,
    c.selected ? `mensaje seleccionado por el usuario: id ${c.selected.id} · ${lineOf(c.selected, c)}` : null,
  ].filter(Boolean) as string[];
  const lines: string[] = [];
  const ids: string[] = [];
  let used = head.join("\n").length + 80;
  const visible = c.messages.filter((m) => !m.id.startsWith("local-"));
  for (let i = visible.length - 1; i >= 0; i--) {
    const l = lineOf(visible[i]!, c);
    if (used + l.length + 1 > budget) break;
    used += l.length + 1;
    lines.unshift(l);
    ids.push(visible[i]!.id);
  }
  const older = visible.length - lines.length;
  const text = [
    ...head,
    `últimos ${lines.length} mensajes (antiguo → reciente)${older > 0 ? ` · hay ${older}+ anteriores: read_messages/search_messages` : ""}:`,
    ...lines,
  ].join("\n");
  return { text, includedIds: ids };
}

/** Messages that arrived after the agent last looked — the only context a follow-up turn needs. */
export function deltaSince(c: CapsuleInput, sinceTs: number): string | null {
  const fresh = c.messages.filter((m) => m.ts > sinceTs && !m.id.startsWith("local-"));
  if (fresh.length === 0) return null;
  return [`mensajes nuevos desde tu última respuesta:`, ...fresh.slice(-30).map((m) => lineOf(m, c))].join("\n");
}

/** Standing instructions, sent once per session. */
export function agentBrief(chatJid: string): string {
  return [
    "Eres el asistente de IA integrado en Wacon, un cliente de WhatsApp en la terminal. Te habla el usuario desde un panel lateral, con el chat de abajo abierto.",
    "- Tienes acceso a TODO su WhatsApp, no solo a este chat: todos sus chats y grupos y su historial.",
    "  · Preguntas sobre este chat: el contexto de abajo suele bastar; si no, read_messages / search_messages con su id.",
    "  · Preguntas generales («¿dónde…?», «¿quién me…?», «en qué grupos…»): busca en todos los chats, sin pasar `chat`. Enlaces y archivos (sheets, formularios, docs, Drive, Meet): find_links. Para listar chats: list_chats; para encontrar a alguien: resolve_contact.",
    "  · Al responder sobre otros chats, di siempre en qué chat o grupo y cuándo.",
    "- Responde en español, breve y directo. El panel es estrecho: nada de tablas ni encabezados; viñetas cortas.",
    "- Si la tarea lo pide (investigar un tema, revisar un documento, trabajar en algo que le encargaron), usa también tus otras herramientas y MCP habituales.",
    "- Ahorra tokens: no leas más de lo necesario. El usuario ve cada herramienta que usas.",
    "- Si salen fechas futuras o cosas por hacer, propón añadirlas a su agenda con propose_event / propose_task (fecha ISO local); el usuario confirma.",
    `- NUNCA envíes mensajes de WhatsApp. Para proponer uno, llama a propose_reply(chat=<id del chat>, text=...) — normalmente chat="${chatJid}" — y el usuario decidirá si lo envía.`,
    "- Si el usuario pide recordar algo de un contacto, usa remember_fact.",
    `- El chat abierto es "${chatJid}".`,
  ].join("\n");
}

/** Compose the text actually sent for one turn. */
export function composePrompt(p: { request: string; brief: string | null; context: string | null }): string {
  return [p.brief, p.context ? `<contexto_del_chat>\n${p.context}\n</contexto_del_chat>` : null, `Petición del usuario: ${p.request}`]
    .filter(Boolean)
    .join("\n\n");
}

// ── quick actions ──────────────────────────────────────────

export interface QuickAction {
  id: string;
  label: string;
  hint: string;
  prompt: string;
  /** The action needs words from the user ("Buscar …"): prefill instead of running. */
  needsText?: boolean;
  /** Only makes sense with a selected message. */
  needsSelection?: boolean;
  /** Opens the agent/model picker instead of asking. */
  picker?: boolean;
}

export const QUICK_ACTIONS: readonly QuickAction[] = [
  { id: "resumir", label: "Resumir el chat", hint: "lo importante, acuerdos y pendientes", prompt: "Resume esta conversación: lo importante, lo acordado y lo pendiente, en 3 a 6 viñetas." },
  { id: "no-leidos", label: "¿Qué me perdí?", hint: "solo lo no leído", prompt: "Resume solo los mensajes que no he leído y dime si alguno necesita respuesta." },
  { id: "responder", label: "Sugerir respuesta", hint: "con tu estilo con esta persona", prompt: "Propón una respuesta al último mensaje escrita como yo le escribo a esta persona (consulta get_contact_profile o get_persona si hace falta) y entrégala con propose_reply. Explica en una línea por qué." },
  { id: "pendientes", label: "¿Qué tengo pendiente?", hint: "compromisos con este contacto", prompt: "¿Qué tengo pendiente con este contacto? Revisa los compromisos (get_commitments) y lo hablado recientemente." },
  { id: "recordar", label: "Recordar lo importante", hint: "guarda hechos en la memoria", prompt: "Del contexto reciente, extrae hechos duraderos sobre este contacto (gustos, fechas, planes, datos) y guárdalos con remember_fact. Dime en viñetas qué guardaste." },
  { id: "explicar", label: "Explicar el mensaje", hint: "foto, audio o texto seleccionado", prompt: "Explica el mensaje seleccionado. Si es una foto usa view_image; si es un audio, transcribe_audio.", needsSelection: true },
  { id: "traducir", label: "Traducir", hint: "el mensaje seleccionado o el último", prompt: "Traduce al español el mensaje seleccionado (o el último que recibí) y explica cualquier modismo." },
  { id: "cambiar", label: "Cambiar de agente o modelo", hint: "Ctrl+L", prompt: "", picker: true },
  { id: "buscar", label: "Buscar en este chat…", hint: "escribe qué buscar", prompt: "Busca en el historial de este chat y resume lo que encuentres sobre: ", needsText: true },
  { id: "buscar-todo", label: "Buscar en todos mis chats…", hint: "en cualquier chat o grupo", prompt: "Busca en TODOS mis chats y grupos (sin limitarte a este) y dime dónde y cuándo se habló de: ", needsText: true },
  { id: "enlaces", label: "Sheets y formularios por llenar", hint: "enlaces compartidos en todos tus chats", prompt: "¿Dónde me enviaron sheets, Excel o formularios para llenar? Usa find_links con kinds sheets y forms en todos mis chats. Agrupa por chat o grupo, con la fecha y el enlace, lo más reciente primero." },
];

export function matchQuickActions(query: string, list: readonly QuickAction[] = QUICK_ACTIONS): QuickAction[] {
  const q = query.replace(/^\//, "").trim().toLowerCase();
  if (!q) return [...list];
  return list.filter((a) => a.id.includes(q) || a.label.toLowerCase().includes(q));
}

// ── permissions ────────────────────────────────────────────

/**
 * Some agents (Gemini, Qwen…) ask before every MCP tool call. Wacon's own
 * toolset inside the app cannot send anything, so asking the user four times
 * per question is pure friction: those are approved for the session. Anything
 * else the agent wants to do still goes to the user.
 */
export function autoApproval(title: string, options: readonly PermissionChoice[]): string | null {
  if (!waconTool(title)) return null;
  const always = options.filter((o) => o.kind === "allow_always");
  const pick = always.find((o) => /server/i.test(o.id)) ?? always[0] ?? options.find((o) => o.kind === "allow_once");
  return pick?.id ?? null;
}


// ── home: the AI over the whole WhatsApp ───────────────────

/** Key under which the home screen's conversation is stored (no chat open). */
export const HOME = "__home__";

export interface InboxLine {
  name: string;
  isGroup: boolean;
  unread: number;
  lastTs: number;
  preview: string;
}

/** Day-to-day help, shown as cards on the home screen. */
export const HOME_ACTIONS: readonly QuickAction[] = [
  { id: "hoy", label: "Resumen de hoy", hint: "lo que pasó y lo urgente", prompt: "Dame el resumen de hoy en mi WhatsApp: qué es importante, qué necesita respuesta y quién me escribió. Usa get_briefing o get_inbox. Agrupa en viñetas cortas, lo urgente primero." },
  { id: "responder", label: "¿Qué me falta responder?", hint: "chats esperando tu respuesta", prompt: "¿Qué conversaciones están esperando mi respuesta? Usa get_inbox. Dime quién, qué me pidió y desde cuándo, lo más urgente primero." },
  { id: "fechas", label: "Fechas y eventos próximos", hint: "exámenes, reuniones, entregas", prompt: "¿Qué fechas, reuniones, entregas o eventos próximos se mencionaron en mis chats? Revisa get_agenda y busca en todos mis chats (search_messages) palabras como fecha, examen, entrega, reunión, mañana. Lista por fecha, con el chat de origen, y propón añadir a mi agenda las futuras con propose_event." },
  { id: "enlaces", label: "Sheets y formularios", hint: "lo que te pidieron llenar", prompt: "¿Dónde me enviaron sheets, Excel o formularios para llenar? Usa find_links con kinds sheets y forms en todos mis chats. Agrupa por chat o grupo, con la fecha, lo más reciente primero." },
  { id: "pendientes", label: "Mis compromisos", hint: "lo que prometiste hacer", prompt: "¿Qué compromisos o tareas tengo pendientes según mis chats (cosas que prometí o me pidieron)? Usa get_commitments. Dime con quién y para cuándo." },
  { id: "buscar-todo", label: "Buscar en todo…", hint: "cualquier tema en cualquier chat", prompt: "Busca en TODOS mis chats y grupos y dime dónde y cuándo se habló de: ", needsText: true },
];

/** The home context: a compact inbox, never message contents beyond the previews. */
export function homeCapsule(inbox: readonly InboxLine[], now: number, budget = 3000): string {
  const lines: string[] = [];
  let used = 0;
  for (const c of inbox) {
    const l = `${c.isGroup ? "grupo" : "chat"} ${c.name}${c.unread ? ` · ${c.unread} sin leer` : ""} · ${ago(now - c.lastTs)} · ${truncate(c.preview.replace(/\s+/g, " "), 80)}`;
    if (used + l.length > budget) break;
    used += l.length + 1;
    lines.push(l);
  }
  return [`sin chat abierto: el usuario pregunta sobre todo su WhatsApp`, `chats recientes (${lines.length}):`, ...lines].join("\n");
}

const ago = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `hace ${h} h` : `hace ${Math.round(h / 24)} d`;
};

/** Standing instructions when no chat is open. */
export function homeBrief(): string {
  return [
    "Eres el asistente de IA integrado en Wacon, un cliente de WhatsApp en la terminal. Ayudas al usuario en su día a día con TODO su WhatsApp: todos sus chats y grupos y su historial.",
    "- Usa las herramientas wacon: get_briefing / get_inbox (lo reciente y lo pendiente), get_agenda y get_commitments (fechas y compromisos), search_messages sin `chat` (cualquier tema), find_links (sheets, formularios, documentos), list_chats y resolve_contact.",
    "- Di siempre en qué chat o grupo y cuándo. Responde en español, breve: viñetas cortas, sin tablas ni encabezados.",
    "- Si una tarea lo pide (investigar, revisar un documento o un repositorio, preparar algo que le encargaron en un chat), usa también tus otras herramientas y MCP habituales.",
    "- Ahorra tokens: no leas más de lo necesario. El usuario ve cada herramienta que usas.",
    "- NUNCA envíes mensajes de WhatsApp. Para proponer uno usa propose_reply(chat=<id>, text=...) y el usuario decidirá.",
    "- Si encuentras fechas futuras (exámenes, entregas, reuniones) o cosas por hacer, propón añadirlas a su agenda con propose_event / propose_task (fecha ISO local); el usuario confirma cada una.",
  ].join("\n");
}

// ── handoff between agents ─────────────────────────────────

/**
 * When an agent runs out of quota (or the user switches), the next one gets
 * what was already said — not the whole transcript, a compact recap.
 */
export function handoffRecap(turns: readonly { request: string; label: string | null; text: string }[], budget = 2500): string | null {
  const done = turns.filter((t) => t.text.trim());
  if (done.length === 0) return null;
  const parts: string[] = [];
  let used = 0;
  for (let i = done.length - 1; i >= 0; i--) {
    const t = done[i]!;
    const p = `- el usuario pidió: ${truncate(t.label ?? t.request, 160)}\n  se respondió: ${truncate(t.text.replace(/\s+/g, " "), 420)}`;
    if (used + p.length > budget) break;
    used += p.length;
    parts.unshift(p);
  }
  return [`conversación previa con otro asistente (continúa desde aquí):`, ...parts].join("\n");
}

/** Quota, rate-limit or capacity errors: the moment to offer another model or agent. */
export function isQuotaError(message: string): boolean {
  return /limit|quota|429|rate|exhausted|resets|insufficient|credit|usage cap|too many requests|límite|high demand|overloaded|capacity|503|unavailable/i.test(message);
}

// ── models ─────────────────────────────────────────────────

/** Short label for the header chip: "Claude Code · sonnet". */
export function agentChip(agentName: string, model: ModelOption | null): string {
  return model ? `${agentName} · ${model.name}` : agentName;
}
