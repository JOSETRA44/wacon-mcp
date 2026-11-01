import { Box, Text, useAnimation } from "ink";
import type { AgentTurn, ChatAgentState, ModelsState, PendingPermission } from "../../application/agent-controller.js";
import type { DetectedAgent, ModelOption, QuickAction } from "../../domain/agent.js";
import { proposalLine } from "../../domain/agenda.js";
import { cells, padCells, truncate, wrap } from "../../domain/text.js";
import type { EditorState } from "../editor.js";
import { SPINNER, useTheme, type Palette } from "../themes.js";
import { Spinner } from "./Spinner.js";

/**
 * "Modo IA" side panel. Reads like a chat with the agent: your request, then
 * what it is doing (each tool as a live step), then its answer. A proposed
 * message appears as a card you can send, edit or drop — the agent itself
 * can never send.
 */

interface Seg {
  text: string;
  color?: string;
  bold?: boolean;
}
type PanelLine = Seg[];

/** Agents answer in Markdown; a narrow terminal panel wants plain text. */
export function plainText(md: string): string[] {
  return md
    .replace(/\r/g, "")
    .split("\n")
    .map((l) =>
      l
        .replace(/^\s{0,3}#{1,6}\s+/, "")
        .replace(/^\s*[-*+]\s+/, "• ")
        .replace(/\*\*(.+?)\*\*/g, "$1")
        .replace(/__(.+?)__/g, "$1")
        .replace(/`([^`]+)`/g, "$1")
    );
}

export interface TurnView {
  /** Show the agent's whole reasoning instead of a folded line. */
  showThinking: boolean;
  /** Who answered the previous turn: a change of agent/model is labelled. */
  previousBy: string | null;
  /** Names to offer when the agent ran out of quota. */
  alternatives: string[];
  now: number;
}

export function turnLines(turn: AgentTurn, width: number, c: Palette, frame: number, view: TurnView = { showThinking: false, previousBy: null, alternatives: [], now: Date.now() }): PanelLine[] {
  const out: PanelLine[] = [];
  const w = Math.max(10, width);
  if (view.previousBy && view.previousBy !== turn.by) out.push([{ text: `↻ ahora con ${truncate(turn.by, w - 12)}`, color: c.faint }]);
  for (const [i, l] of wrap(turn.label ?? turn.request, w - 2).entries()) out.push([{ text: i === 0 ? "› " : "  ", color: c.accentSoft }, { text: l, color: c.text, bold: true }]);
  // Native reasoning (ACP agent_thought_chunk, Claude thinking blocks, Codex
  // reasoning): live while it thinks, then folded to one line — the way agent
  // panels in editors show it — unless the user asked to see it all.
  const thinking = turn.thinking?.trim();
  if (thinking) {
    const thinkingLive = turn.status === "running" && !turn.text;
    const secs = Math.max(1, Math.round(((turn.answeredAt ?? view.now) - turn.startedAt) / 1000));
    if (thinkingLive || view.showThinking) {
      out.push([{ text: `  💭 ${thinkingLive ? "pensando" : `pensó ${secs} s`}`, color: c.faint }]);
      const lines = plainText(thinking).flatMap((l) => (l.trim() ? wrap(l, w - 4) : []));
      for (const l of thinkingLive && !view.showThinking ? lines.slice(-3) : lines) out.push([{ text: `  │ ${l}`, color: c.faint }]);
    } else {
      out.push([{ text: `  💭 pensó ${secs} s · Alt+T ver`, color: c.faint }]);
    }
  }
  for (const step of turn.tools) {
    const icon = step.status === "running" ? SPINNER[frame % SPINNER.length]! : step.status === "done" ? "✓" : "✗";
    const color = step.status === "failed" ? c.error : step.status === "done" ? c.muted : c.accentSoft;
    out.push([{ text: `  ${icon} `, color }, { text: truncate(step.label, w - 4), color }]);
  }
  if (turn.status === "running" && !turn.text && !thinking && turn.tools.every((t) => t.status !== "running")) {
    out.push([{ text: `  ${SPINNER[frame % SPINNER.length]} `, color: c.accentSoft }, { text: "pensando…", color: c.muted }]);
  }
  if (turn.text) {
    out.push([{ text: "" }]);
    for (const para of plainText(turn.text.trim())) {
      if (!para.trim()) {
        out.push([{ text: "" }]);
        continue;
      }
      const bullet = para.startsWith("• ");
      for (const [i, l] of wrap(bullet ? para.slice(2) : para, w - (bullet ? 2 : 0)).entries()) {
        out.push(bullet ? [{ text: i === 0 ? "• " : "  ", color: c.accentSoft }, { text: l, color: c.text }] : [{ text: l, color: c.text }]);
      }
    }
  }
  if (turn.status === "error" && turn.error) for (const l of wrap(`⚠ ${turn.error}`, w)) out.push([{ text: l, color: c.error }]);
  if (turn.status === "error" && turn.quota) {
    const alt = view.alternatives.slice(0, 3).join(", ");
    for (const l of wrap(`↻ Ctrl+L para seguir con otro modelo u otro agente${alt ? ` (${alt})` : ""} — la conversación continúa donde quedó.`, w)) out.push([{ text: l, color: c.accentSoft }]);
  }
  if (turn.status === "cancelled") out.push([{ text: "⏹ cancelado", color: c.muted }]);
  out.push([{ text: "" }]);
  return out;
}

export const agentInputHeight = (editor: EditorState, width: number) =>
  Math.min(4, editor.text.split("\n").reduce((n, l) => n + Math.max(1, Math.ceil(cells(l + " ") / Math.max(1, width - 4))), 0)) + 2;

interface Props {
  agent: DetectedAgent | null;
  /** The model it runs on, for the header chip. */
  model?: ModelOption | null;
  /** Home: no chat open — the AI over the whole WhatsApp, with day-to-day cards. */
  home?: boolean;
  homeActions?: readonly QuickAction[];
  /** Home: "Hoy" lines computed locally (unread, agenda, promises) — no tokens. */
  today?: string[];
  /** Name of the chat a home draft goes to. */
  draftChatName?: string | null;
  view?: Omit<TurnView, "previousBy" | "now">;
  chatName: string;
  state: ChatAgentState;
  busy: boolean;
  focused: boolean;
  input: EditorState;
  menu: { items: QuickAction[]; index: number } | null;
  width: number;
  height: number;
}

export function AgentPanel({ agent, model = null, home = false, homeActions = [], today = [], draftChatName = null, view = { showThinking: false, alternatives: [] }, chatName, state, busy, focused, input, menu, width, height }: Props) {
  const theme = useTheme().c;
  const running = busy || state.turns.some((t) => t.status === "running");
  const { frame } = useAnimation({ interval: 90, isActive: running });
  const inner = width - 2;

  // Bottom-up budget: input, optional draft card, optional menu; the transcript gets the rest.
  const inputH = agentInputHeight(input, inner);
  const draftLines = state.draft ? wrap(state.draft.text, inner - 4).slice(0, 6) : [];
  // border ×2 + title + hint around the text lines
  const draftH = state.draft ? draftLines.length + 4 : 0;
  // Agenda proposal card (only when no draft is waiting): border ×2 + 3 lines.
  const proposal = !state.draft ? (state.proposals?.[0] ?? null) : null;
  const proposalH = proposal ? 5 : 0;
  const menuItems = menu?.items.slice(0, 8) ?? [];
  const menuH = menu ? Math.max(1, menuItems.length) + 1 : 0;
  const bodyH = Math.max(1, height - 1 - inputH - draftH - proposalH - menuH);

  const now = Date.now();
  const lines = state.turns.flatMap((t, i) => turnLines(t, inner, theme, frame, { ...view, previousBy: i > 0 ? state.turns[i - 1]!.by : null, now }));
  const shown = lines.slice(-bodyH);

  const usage = state.usage
    ? ` ${fmtTokens(state.usage.inputTokens + state.usage.outputTokens)} tok${state.usage.costUsd ? ` · $${state.usage.costUsd.toFixed(3)}` : ""}`
    : "";
  const status = running ? "trabajando" : "listo";

  return (
    <Box flexDirection="column" width={width} height={height} backgroundColor={theme.panel}>
      <Box height={1} width={width} backgroundColor={theme.header}>
        <Text backgroundColor={theme.header} color={theme.accent} bold>{home ? " ◉ wacon · IA " : " ✦ "}</Text>
        <Text backgroundColor={theme.header} color={theme.text} bold>{truncate(agent ? agent.name : "elige tu agente · Ctrl+L", Math.max(6, width - 34 - cells(usage) - (home ? 12 : 0)))}</Text>
        {agent ? <Text backgroundColor={theme.header} color={theme.accentSoft}>{` · ${truncate(model?.name ?? "predeterminado", 18)} ▾`}</Text> : null}
        <Text backgroundColor={theme.header} color={running ? theme.accentSoft : theme.muted}>
          {"  "}
          {running ? <Spinner color={theme.accentSoft} /> : "●"}
          {` ${status}`}
        </Text>
        <Text backgroundColor={theme.header} color={theme.faint}>{usage}</Text>
      </Box>

      <Box flexDirection="column" height={bodyH} paddingX={1} overflow="hidden">
        {state.turns.length === 0 ? (
          home ? <HomeCards agent={agent} actions={homeActions} today={today} width={inner} height={bodyH} /> : <EmptyState agent={agent} chatName={chatName} width={inner} />
        ) : (
          shown.map((segs, i) => (
            <Text key={i} wrap="truncate">
              {segs.map((s, j) => (
                <Text key={j} color={s.color} bold={s.bold}>
                  {s.text}
                </Text>
              ))}
            </Text>
          ))
        )}
      </Box>

      {state.draft ? (
        <Box flexDirection="column" flexShrink={0} marginX={1} borderStyle="round" borderColor={theme.accent} paddingX={1}>
          <Text color={theme.accentSoft} bold>{`✎ Borrador para ${truncate((home ? draftChatName : chatName) ?? "un chat", inner - 20)}`}</Text>
          {draftLines.map((l, i) => (
            <Text key={i} color={theme.text}>
              {l}
            </Text>
          ))}
          <Text color={theme.faint}>{truncate(!focused ? "Ctrl+A para usarlo" : home ? "Tab abre el chat con el borrador · Esc descartar" : "↵ enviar · Tab al compositor · Esc descartar", inner - 4)}</Text>
        </Box>
      ) : null}

      {proposal ? (
        <Box flexDirection="column" flexShrink={0} marginX={1} borderStyle="round" borderColor={theme.accent} paddingX={1}>
          <Text color={theme.accentSoft} bold>{truncate(`¿Añadir a tu agenda?${state.proposals.length > 1 ? `  (${state.proposals.length - 1} más)` : ""}`, inner - 4)}</Text>
          <Text color={theme.text}>{truncate(proposalLine(proposal, Date.now()), inner - 4)}</Text>
          <Text color={theme.faint}>{truncate(focused ? "↵ añadir · Esc descartar" : "Ctrl+A para decidir", inner - 4)}</Text>
        </Box>
      ) : null}

      {menu ? (
        <Box flexDirection="column" flexShrink={0} paddingX={1}>
          {menuItems.length === 0 ? <Text color={theme.muted}>Ninguna acción coincide</Text> : null}
          {menuItems.map((a, i) => {
            const active = i === menu.index;
            const bg = active ? theme.rowSelected : theme.panel;
            const labelW = Math.min(26, Math.max(10, inner - 14));
            return (
              <Box key={a.id}>
                <Text backgroundColor={bg} color={active ? theme.accent : theme.text} bold={active}>{padCells(`${active ? "▸" : " "} ${truncate(a.label, labelW - 2)}`, labelW)}</Text>
                <Text backgroundColor={bg} color={theme.faint}>{padCells(truncate(` ${a.hint}`, inner - labelW), inner - labelW)}</Text>
              </Box>
            );
          })}
          <Text color={theme.faint}>{truncate("↑↓ elegir · ↵ ejecutar · Esc cerrar", inner)}</Text>
        </Box>
      ) : null}

      <Box flexShrink={0} borderStyle="round" borderColor={focused ? theme.accent : theme.border} paddingX={1} width={width}>
        {input.text ? (
          <Text color={theme.text} wrap="wrap">
            {input.text.slice(0, input.cursor)}
            {focused ? <Text inverse>{input.text[input.cursor] ?? " "}</Text> : null}
            {input.text.slice(input.cursor + (focused ? 1 : 0))}
          </Text>
        ) : (
          <Text>
            {focused ? <Text inverse> </Text> : null}
            <Text color={theme.faint}>{truncate(running ? "Esc cancela · puedes escribir la siguiente pregunta" : home ? (focused ? "Pregúntale a tu IA sobre todo tu WhatsApp · 1-6 · / más" : "Tab para preguntarle a tu IA · 1-6 acciones rápidas") : "Pregunta sobre este chat · / acciones rápidas", inner - 4)}</Text>
          </Text>
        )}
      </Box>
    </Box>
  );
}

/** Home with nothing asked yet: what the AI can do for the day, one key away. */
function HomeCards({ agent, actions, today, width, height }: { agent: DetectedAgent | null; actions: readonly QuickAction[]; today: string[]; width: number; height: number }) {
  const theme = useTheme().c;
  const hour = new Date().getHours();
  const hello = hour < 12 ? "Buenos días" : hour < 19 ? "Buenas tardes" : "Buenas noches";
  const twoCols = width >= 70;
  const cardW = twoCols ? Math.floor((width - 2) / 2) : width;
  const rows: QuickAction[][] = [];
  for (let i = 0; i < actions.length; i += twoCols ? 2 : 1) rows.push(actions.slice(i, i + (twoCols ? 2 : 1)));
  // Fit the height instead of letting the terminal clip lines at random:
  // drop the card hints first, then the footer, then the subtitle.
  const todayH = today.length ? today.length + 2 : 0;
  let hints = true, footer = true, subtitle = true;
  const need = () => 1 + (subtitle ? 1 : 0) + 1 + todayH + rows.length * (hints ? 2 : 1) + (footer ? 3 : 0);
  if (need() > height) hints = false;
  if (need() > height) footer = false;
  if (need() > height) subtitle = false;
  return (
    <Box flexDirection="column">
      <Text color={theme.text} bold>{truncate(`${hello}. ${agent ? `${agent.name} está listo para ayudarte con tu día.` : "Elige tu agente de IA con Ctrl+L."}`, width)}</Text>
      {subtitle ? <Text color={theme.faint}>{truncate("Ve todos tus chats y grupos; solo lee lo necesario y nunca envía nada sin ti.", width)}</Text> : null}
      <Text> </Text>
      {today.length ? (
        <>
          <Text color={theme.accentSoft} bold>HOY</Text>
          {today.map((l) => (
            <Text key={l} color={theme.text}>
              {truncate(l, width)}
            </Text>
          ))}
          <Text> </Text>
        </>
      ) : null}
      {rows.map((row, r) => (
        <Box key={r} flexDirection="column">
          <Box>
            {row.map((a, c) => (
              <Text key={a.id} color={theme.text}>
                <Text color={theme.accent} bold>{` ${r * (twoCols ? 2 : 1) + c + 1} `}</Text>
                <Text bold>{padCells(truncate(a.label, cardW - 4), cardW - 3)}</Text>
              </Text>
            ))}
          </Box>
          {hints ? (
            <Box>
              {row.map((a) => (
                <Text key={a.id} color={theme.faint}>{padCells(`   ${truncate(a.hint, cardW - 4)}`, cardW)}</Text>
              ))}
            </Box>
          ) : null}
        </Box>
      ))}
      {footer ? (
        <>
          <Text> </Text>
          <Text color={theme.faint}>{truncate("A la izquierda tus chats: ↑↓ y ↵ para abrir uno, escribe para buscarlo · Ctrl+K ir a… · ? atajos", width)}</Text>
          <Text color={theme.faint}>{truncate("Tu historial se guarda solo en este equipo (~/.wacon).", width)}</Text>
        </>
      ) : null}
    </Box>
  );
}

function EmptyState({ agent, chatName, width }: { agent: DetectedAgent | null; chatName: string; width: number }) {
  const theme = useTheme().c;
  const lines: [string, string | undefined, boolean?][] = [
    [`${agent?.name ?? "Tu agente"} está listo para ${chatName}.`, theme.text, true],
    ["", undefined],
    ["Escribe una pregunta, o / para:", theme.muted],
    ["  • Resumir el chat · ¿Qué me perdí?", theme.muted],
    ["  • Sugerir respuesta con tu estilo", theme.muted],
    ["  • Recordar lo importante en la memoria", theme.muted],
    ["", undefined],
    ["No recibe nada hasta que preguntas. Lee solo lo", theme.faint],
    ["necesario (✦ marca lo que miró) y nunca envía", theme.faint],
    ["mensajes: te propone un borrador.", theme.faint],
  ];
  return (
    <Box flexDirection="column">
      {lines.flatMap(([l, color, bold], i) =>
        (l ? wrap(l, width) : [" "]).map((x, j) => (
          <Text key={`${i}-${j}`} color={color} bold={bold}>
            {x}
          </Text>
        ))
      )}
    </Box>
  );
}

const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

const centered = (width: number, w: number) => Math.max(0, Math.floor((width - w) / 2));

const PROTOCOL_LABEL: Record<DetectedAgent["protocol"], string> = { acp: "ACP", "claude-stream": "stream", "codex-json": "stream" };

/** Ctrl+A the first time (or from the palette): which installed agent to use. */
export function AgentPicker(p: {
  phase: "idle" | "detecting" | "ready";
  agents: DetectedAgent[];
  activeId: string | null;
  index: number;
  width: number;
  /** Second step: the models of `modelsFor`. */
  modelsFor?: DetectedAgent | null;
  models?: ModelsState | null;
  chosenModel?: string | null;
  power?: "full" | "wacon";
  /** Recent quota/capacity error for an agent (and model), to warn before choosing it. */
  quota?: (agentId: string, modelId?: string | null) => string | null;
}) {
  const theme = useTheme().c;
  const w = Math.min(64, p.width - 4);
  if (p.modelsFor) {
    const list = p.models?.list ?? [];
    const rows = [{ id: "", name: "Predeterminado del agente", description: p.models?.current ? `ahora: ${p.models.current}` : "el que el agente usa por defecto" }, ...list];
    const max = 10;
    const start = Math.max(0, Math.min(p.index - Math.floor(max / 2), rows.length - max));
    return (
      <Box position="absolute" top={3} left={centered(p.width, w)} width={w} flexDirection="column" borderStyle="round" borderColor={theme.accent} backgroundColor={theme.panel} paddingX={1}>
        <Text color={theme.text} bold>{truncate(`✦ ${p.modelsFor.name} · elige el modelo`, w - 4)}</Text>
        <Text color={theme.faint}>{truncate("Los modelos que te ofrece este agente con tu cuenta.", w - 4)}</Text>
        <Text> </Text>
        {p.models?.phase !== "ready" ? (
          <Text color={theme.muted}>
            <Spinner color={theme.accent} /> preguntando al agente qué modelos tiene…
          </Text>
        ) : null}
        {rows.slice(start, start + max).map((m, i) => {
          const active = start + i === p.index;
          const chosen = (p.chosenModel ?? "") === m.id;
          const tired = p.quota?.(p.modelsFor!.id, m.id || null) ?? null;
          const bg = active ? theme.rowSelected : theme.panel;
          const nameW = Math.min(26, Math.max(12, w - 30));
          return (
            <Box key={m.id || "default"}>
              <Text backgroundColor={bg} color={chosen ? theme.accent : theme.faint}>{chosen ? " ● " : "   "}</Text>
              <Text backgroundColor={bg} color={active ? theme.text : theme.muted} bold={active}>{padCells(truncate(m.name, nameW - 1), nameW)}</Text>
              <Text backgroundColor={bg} color={tired ? theme.warn : theme.faint}>{padCells(truncate(tired ? `⚠ ${tired}` : (m.description ?? ""), w - nameW - 8), w - nameW - 7)}</Text>
            </Box>
          );
        })}
        {p.models?.phase === "ready" && list.length === 0 ? <Text color={theme.muted}>{truncate("Este agente no informa sus modelos: usará su predeterminado.", w - 4)}</Text> : null}
        <Text> </Text>
        <Text color={theme.faint}>{truncate("↑↓ elegir · ↵ usar · ← agentes · Esc cerrar", w - 4)}</Text>
      </Box>
    );
  }
  return (
    <Box position="absolute" top={3} left={centered(p.width, w)} width={w} flexDirection="column" borderStyle="round" borderColor={theme.accent} backgroundColor={theme.panel} paddingX={1}>
      <Text color={theme.text} bold>✦ Modo IA · elige tu agente</Text>
      <Text color={theme.faint}>{truncate("Agentes de IA instalados en este equipo. Usan tu propia cuenta.", w - 4)}</Text>
      <Text color={theme.muted}>
        {"Capacidades: "}
        <Text color={theme.accentSoft} bold>{p.power === "wacon" ? "solo Wacon (más barato)" : "completas (sus MCP, skills y herramientas + Wacon)"}</Text>
        <Text color={theme.faint}>{" · c cambiar"}</Text>
      </Text>
      <Text> </Text>
      {p.phase !== "ready" ? (
        <Text color={theme.muted}>
          <Spinner color={theme.accent} /> buscando agentes instalados…
        </Text>
      ) : p.agents.length === 0 ? (
        <>
          <Text color={theme.text}>No encontré ningún agente compatible.</Text>
          <Text color={theme.muted}>{truncate("Instala uno (Claude Code, Codex, Gemini CLI, Copilot CLI,", w - 4)}</Text>
          <Text color={theme.muted}>{truncate("OpenCode, Qwen o Kimi) y pulsa r para buscar de nuevo.", w - 4)}</Text>
        </>
      ) : (
        p.agents.map((a, i) => {
          const active = i === p.index;
          const bg = active ? theme.rowSelected : theme.panel;
          const nameW = Math.max(12, w - 26);
          return (
            <Box key={a.id}>
              <Text backgroundColor={bg} color={a.id === p.activeId ? theme.accent : theme.faint}>{a.id === p.activeId ? " ● " : "   "}</Text>
              <Text backgroundColor={bg} color={active ? theme.text : theme.muted} bold={active}>{padCells(truncate(`${a.name}${p.quota?.(a.id) ? " ⚠" : ""}`, nameW - 1), nameW)}</Text>
              <Text backgroundColor={bg} color={p.quota?.(a.id) ? theme.warn : theme.faint}>{padCells(truncate(p.quota?.(a.id) ? "sin cuota" : (a.version ?? ""), 10), 11)}</Text>
              <Text backgroundColor={bg} color={a.protocol === "acp" ? theme.accentSoft : theme.tick}>{padCells(PROTOCOL_LABEL[a.protocol], 7)}</Text>
            </Box>
          );
        })
      )}
      <Text> </Text>
      <Text color={theme.faint}>{truncate("↑↓ elegir · ↵ usar · → modelo · c capacidades · r buscar · Esc", w - 4)}</Text>
    </Box>
  );
}

/** An agent asks before doing something (ACP's session/request_permission). */
export function PermissionDialog({ request, agentName, width }: { request: PendingPermission; agentName: string; width: number }) {
  const theme = useTheme().c;
  const w = Math.min(64, width - 4);
  return (
    <Box position="absolute" top={4} left={centered(width, w)} width={w} flexDirection="column" borderStyle="round" borderColor={theme.warn} backgroundColor={theme.panel} paddingX={1}>
      <Text color={theme.warn} bold>🔐 {truncate(agentName, w - 16)} pide permiso</Text>
      <Text color={theme.text}>{truncate(request.title, w - 4)}</Text>
      <Text> </Text>
      {request.options.map((o, i) => (
        <Text key={o.id} color={o.kind.startsWith("reject") ? theme.muted : theme.text}>
          <Text color={theme.accent} bold>{`${i + 1} `}</Text>
          {truncate(o.label, w - 8)}
        </Text>
      ))}
      <Text> </Text>
      <Text color={theme.faint}>{truncate(`1-${request.options.length} elegir · Esc rechazar`, w - 4)}</Text>
    </Box>
  );
}
