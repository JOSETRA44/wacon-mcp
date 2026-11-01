import {
  agentBrief,
  autoApproval,
  buildContextCapsule,
  composePrompt,
  deltaSince,
  draftFrom,
  handoffRecap,
  homeBrief,
  homeCapsule,
  isQuotaError,
  HOME,
  type ModelOption,
  readIdsFrom,
  toolLabel,
  waconTool,
  type AgentEvent,
  type CapsuleInput,
  type DetectedAgent,
  type Draft,
  type PermissionChoice,
  type QuickAction,
} from "../domain/agent.js";
import type { ChatMessage } from "../domain/message.js";
import { proposalFrom, type AgendaProposal } from "../domain/agenda.js";
import type { AgentCatalogPort, AgentHistory, AgentHistoryPort, AgentRuntimePort, AgentSession, AgentSessionOptions, ModelList, StoredSession, StoredTurn } from "./ports.js";
import type { UltraController } from "./controller.js";

/**
 * Use cases of "Modo IA". Same contract as UltraController: one store for
 * useSyncExternalStore, and public methods never throw — a broken or
 * logged-out agent becomes a message in the panel, not a crashed terminal.
 *
 * Cost model: nothing is sent to an agent until the user asks. The first
 * question in a chat carries a compact capsule of it; follow-ups carry only
 * the messages that arrived since; anything else the agent reads through
 * Wacon's tools, visibly.
 */

export interface ToolStep {
  id: string;
  label: string;
  status: "running" | "done" | "failed";
}

export interface AgentTurn {
  id: number;
  request: string;
  /** Quick-action name shown instead of the full prompt. */
  label: string | null;
  text: string;
  tools: ToolStep[];
  status: "running" | "done" | "error" | "cancelled";
  error?: string;
  /** The error is about quota/limits: the moment to offer another agent. */
  quota?: boolean;
  /** The agent's native reasoning, streamed as it thinks. */
  thinking: string;
  startedAt: number;
  /** When the answer (first text) started — the thinking time is up to here. */
  answeredAt?: number;
  /** Which agent/model answered, shown when the user switches mid-conversation. */
  by: string;
}

export interface ChatAgentState {
  turns: AgentTurn[];
  /** Messages the agent has looked at — marked in the conversation. */
  readIds: string[];
  draft: Draft | null;
  /** Agenda additions the agent proposed, waiting for the user's OK. */
  proposals: AgendaProposal[];
  usage: { inputTokens: number; outputTokens: number; costUsd: number | null } | null;
}

export interface PendingPermission {
  jid: string;
  requestId: string;
  title: string;
  options: PermissionChoice[];
}

export interface ModelsState {
  phase: "loading" | "ready";
  list: ModelOption[];
  /** The agent's own default, when it says. */
  current: string | null;
}

export interface AgentState {
  catalog: { phase: "idle" | "detecting" | "ready"; agents: DetectedAgent[] };
  /** Models per agent id, loaded on demand for the picker. */
  models: Record<string, ModelsState>;
  /** Chat whose turn is in flight (one at a time keeps the cost predictable). */
  busyJid: string | null;
  chats: Record<string, ChatAgentState>;
  permission: PendingPermission | null;
}

interface LiveSession {
  agentId: string;
  model: string | null;
  power: "full" | "wacon";
  session: AgentSession;
  /** Newest message the agent has seen, so follow-ups send only the delta. */
  seenTs: number;
}

const emptyChat = (): ChatAgentState => ({ turns: [], readIds: [], draft: null, proposals: [], usage: null });
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class AgentController {
  private state: AgentState = { catalog: { phase: "idle", agents: [] }, models: {}, busyJid: null, chats: {}, permission: null };
  private listeners = new Set<() => void>();
  private sessions = new Map<string, LiveSession>();
  private turnSeq = 0;

  /** What survives a restart: conversations, resumable sessions, quota hits. */
  private history: AgentHistory = { chats: {}, sessions: {}, quota: {} };

  constructor(
    private readonly ultra: UltraController,
    private readonly catalog: AgentCatalogPort,
    private readonly runtime: AgentRuntimePort,
    private readonly sessionOptions: (agent: DetectedAgent) => AgentSessionOptions,
    private readonly historyStore: AgentHistoryPort | null = null
  ) {
    if (!historyStore) return;
    this.history = historyStore.load();
    // Each chat's conversation with the AI comes back as it was left.
    const chats: Record<string, ChatAgentState> = {};
    for (const [jid, turns] of Object.entries(this.history.chats)) {
      chats[jid] = { ...emptyChat(), turns: turns.map((t) => ({ ...t, id: ++this.turnSeq, tools: [], startedAt: t.at, answeredAt: t.at })) };
    }
    this.state = { ...this.state, chats };
  }

  /** Persist after each turn: last 20 finished turns per scope, trimmed. */
  private persist(): void {
    if (!this.historyStore) return;
    const chats: Record<string, StoredTurn[]> = {};
    for (const [jid, c] of Object.entries(this.state.chats)) {
      const done = c.turns
        .filter((t) => t.status !== "running")
        .slice(-20)
        .map<StoredTurn>((t) => ({ request: t.request, label: t.label, text: t.text.slice(0, 6000), thinking: t.thinking.slice(0, 1500), by: t.by, status: t.status as StoredTurn["status"], ...(t.error ? { error: t.error } : {}), at: t.startedAt }));
      if (done.length) chats[jid] = done;
    }
    this.history = { ...this.history, chats };
    this.historyStore.save(this.history);
  }

  /** A quota/capacity hit on this agent (and model) within the last 12 h, if any. */
  quotaFor(agentId: string, modelId?: string | null): { at: number; message: string } | null {
    const fresh = (q: { at: number; message: string } | undefined) => (q && Date.now() - q.at < 12 * 3600_000 ? q : null);
    if (modelId !== undefined) return fresh(this.history.quota[`${agentId}|${modelId ?? ""}`]);
    const hits = Object.entries(this.history.quota).filter(([k]) => k.startsWith(`${agentId}|`)).map(([, v]) => fresh(v)).filter(Boolean) as { at: number; message: string }[];
    return hits.sort((a, b) => b.at - a.at)[0] ?? null;
  }

  // ── store plumbing ───────────────────────────────────────
  getState = (): AgentState => this.state;
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  private set(patch: Partial<AgentState> | ((s: AgentState) => Partial<AgentState>)): void {
    const p = typeof patch === "function" ? patch(this.state) : patch;
    this.state = { ...this.state, ...p };
    for (const l of this.listeners) l();
  }
  private patchChat(jid: string, fn: (c: ChatAgentState) => Partial<ChatAgentState>): void {
    this.set((s) => {
      const prev = s.chats[jid] ?? emptyChat();
      return { chats: { ...s.chats, [jid]: { ...prev, ...fn(prev) } } };
    });
  }
  private patchTurn(jid: string, turnId: number, fn: (t: AgentTurn) => Partial<AgentTurn>): void {
    this.patchChat(jid, (c) => ({ turns: c.turns.map((t) => (t.id === turnId ? { ...t, ...fn(t) } : t)) }));
  }

  // ── catalog ──────────────────────────────────────────────
  async detect(force = false): Promise<void> {
    if (this.state.catalog.phase === "detecting") return;
    this.set({ catalog: { ...this.state.catalog, phase: "detecting" } });
    try {
      const agents = await this.catalog.detect(force);
      this.set({ catalog: { phase: "ready", agents } });
    } catch (e) {
      this.set({ catalog: { phase: "ready", agents: [] } });
      this.ultra.inform(`No pude buscar agentes de IA: ${errText(e)}`, "error");
    }
  }

  /** The agent the user picked, if it is still installed. */
  active(): DetectedAgent | null {
    const id = this.ultra.getState().prefs.agent;
    return this.state.catalog.agents.find((a) => a.id === id) ?? null;
  }

  /**
   * Switch agent (and optionally model). The panel's conversation stays: the
   * next question tells the new agent what was already said (handoff), which
   * is how running out of one agent's quota stops being a dead end.
   */
  choose(agentId: string, modelId?: string | null): void {
    const prefs = this.ultra.getState().prefs;
    const models = { ...prefs.agentModels };
    if (modelId !== undefined) {
      if (modelId) models[agentId] = modelId;
      else delete models[agentId];
    }
    const sameAgent = agentId === prefs.agent;
    const sameModel = (prefs.agentModels[agentId] ?? null) === (models[agentId] ?? null);
    if (sameAgent && sameModel) return;
    for (const s of this.sessions.values()) s.session.close();
    this.sessions.clear();
    this.ultra.setPreferences({ agent: agentId, agentModels: models });
    const a = this.state.catalog.agents.find((x) => x.id === agentId);
    const m = this.modelOf(agentId);
    if (a) this.ultra.inform(`Modo IA con ${a.name}${m ? ` · ${m.name}` : ""}`, "success");
  }

  /** Load the models an agent offers (cached by the runtime). */
  async loadModels(agentId: string): Promise<void> {
    const agent = this.state.catalog.agents.find((a) => a.id === agentId);
    if (!agent || this.state.models[agentId]?.phase === "ready") return;
    this.set((s) => ({ models: { ...s.models, [agentId]: { phase: "loading", list: s.models[agentId]?.list ?? [], current: null } } }));
    let list: ModelList = { models: [], current: null };
    try {
      list = await this.runtime.models(agent, this.sessionOptions(agent));
    } catch {
      // no list: the agent's default still works
    }
    this.set((s) => ({ models: { ...s.models, [agentId]: { phase: "ready", list: list.models, current: list.current } } }));
  }

  /** The model the user picked for this agent (or the one it reported as current). */
  modelOf(agentId: string): ModelOption | null {
    const chosen = this.ultra.getState().prefs.agentModels[agentId];
    const st = this.state.models[agentId];
    const id = chosen ?? st?.current ?? null;
    if (!id) return null;
    return st?.list.find((m) => m.id === id) ?? { id, name: id };
  }

  /** Full powers (its own MCPs/skills/tools + Wacon) ↔ only Wacon (cheapest). */
  togglePower(): void {
    const next = this.ultra.getState().prefs.agentPower === "full" ? "wacon" : "full";
    this.ultra.setPreferences({ agentPower: next });
    this.ultra.inform(next === "full" ? "IA con todas sus capacidades: sus MCP, skills y herramientas + Wacon" : "IA solo con Wacon: más rápida y barata", "success");
  }

  /** Other installed agents, for the "switch" offer after a quota error. */
  alternatives(): DetectedAgent[] {
    const id = this.ultra.getState().prefs.agent;
    return this.state.catalog.agents.filter((a) => a.id !== id);
  }

  chat(jid: string | null): ChatAgentState {
    return (jid && this.state.chats[jid]) || emptyChat();
  }

  // ── asking ───────────────────────────────────────────────
  /** Run a quick action (or free text) on the open chat — or, with no chat open, on the whole WhatsApp. */
  async ask(request: string, action: QuickAction | null = null, selectedId: string | null = null): Promise<void> {
    const agent = this.active();
    const u = this.ultra.getState();
    const text = request.trim();
    if (!agent) return this.ultra.inform("Elige primero un agente de IA (Ctrl+L)", "error");
    if (!text) return;
    if (this.state.busyJid) return this.ultra.inform("La IA aún está con la petición anterior (Esc para cancelarla)");
    if (!u.openJid) return this.askHome(agent, text, action);
    const jid = u.openJid;
    const chat = this.ultra.currentChat();
    const convo = u.conversations[jid];
    if (!chat || !convo) return this.ultra.inform("El chat aún se está cargando");

    const capsuleInput: CapsuleInput = {
      chatJid: jid,
      chatName: chat.name,
      isGroup: chat.isGroup,
      isSelf: !!chat.isSelf,
      unread: convo.unreadAtOpen,
      messages: convo.messages,
      memberNames: convo.memberNames,
      selected: (selectedId && convo.messages.find((m) => m.id === selectedId)) || null,
    };
    let live = this.liveFor(jid, agent);
    const resume = live ? null : this.resumable(jid, agent);
    const first = !live && !resume;
    let context: string | null;
    let seenIds: string[] = [];
    if (resume) {
      // Same agent session as last time: it remembers; only what is new goes.
      context = deltaSince(capsuleInput, resume.seenTs);
    } else if (first) {
      const capsule = buildContextCapsule(capsuleInput);
      context = capsule.text;
      seenIds = capsule.includedIds;
    } else {
      context = deltaSince(capsuleInput, live!.seenTs);
      if (capsuleInput.selected) context = [context, `mensaje seleccionado: id ${capsuleInput.selected.id}`].filter(Boolean).join("\n");
    }
    if (first) context = [context, handoffRecap(this.chat(jid).turns)].filter(Boolean).join("\n\n");
    const prompt = composePrompt({ request: text, brief: first ? agentBrief(jid) : null, context });
    await this.run(agent, jid, prompt, text, action, seenIds, live, Math.max(0, ...convo.messages.map((m) => m.ts)), resume);
  }

  /** Home: no chat open — the agent works over the whole WhatsApp, starting from a compact inbox. */
  private async askHome(agent: DetectedAgent, text: string, action: QuickAction | null): Promise<void> {
    const live = this.liveFor(HOME, agent);
    const resume = live ? null : this.resumable(HOME, agent);
    let context: string | null = null;
    if (!live && !resume) {
      const u = this.ultra.getState();
      const inbox = u.chats.slice(0, 25).map((c) => ({ name: c.name, isGroup: c.isGroup, unread: c.unread, lastTs: c.lastTs, preview: c.preview?.text ?? "" }));
      context = [homeCapsule(inbox, Date.now()), handoffRecap(this.chat(HOME).turns)].filter(Boolean).join("\n\n");
    }
    const prompt = composePrompt({ request: text, brief: live || resume ? null : homeBrief(), context });
    await this.run(agent, HOME, prompt, text, action, [], live, 0, resume);
  }

  /**
   * A session from a previous run that the agent can continue (Claude Code
   * and Codex resume by id; ACP agents get a recap instead).
   */
  private resumable(jid: string, agent: DetectedAgent): StoredSession | null {
    if (agent.protocol === "acp") return null;
    const st = this.history.sessions[jid];
    const p = this.ultra.getState().prefs;
    if (!st || st.agentId !== agent.id || st.model !== (p.agentModels[agent.id] ?? null) || st.power !== p.agentPower) return null;
    return st;
  }

  /** The live session for this scope, unless the agent or model changed since. */
  private liveFor(jid: string, agent: DetectedAgent): LiveSession | undefined {
    const live = this.sessions.get(jid);
    const model = this.ultra.getState().prefs.agentModels[agent.id] ?? null;
    if (live && (live.agentId !== agent.id || live.model !== model || live.power !== this.ultra.getState().prefs.agentPower)) {
      live.session.close();
      this.sessions.delete(jid);
      return undefined;
    }
    return live;
  }

  private async run(agent: DetectedAgent, jid: string, prompt: string, text: string, action: QuickAction | null, seenIds: string[], existing: LiveSession | undefined, newestTs: number, resume: StoredSession | null = null): Promise<void> {
    let live = existing;
    const model = this.modelOf(agent.id);
    const turnId = ++this.turnSeq;
    const turn: AgentTurn = { id: turnId, request: text, label: action?.label ?? null, text: "", tools: [], status: "running", thinking: "", startedAt: Date.now(), by: model ? `${agent.name} · ${model.name}` : agent.name };
    this.patchChat(jid, (c) => ({ turns: [...c.turns, turn].slice(-30), readIds: mergeIds(c.readIds, seenIds), draft: null }));
    this.set({ busyJid: jid });

    try {
      if (!live) {
        const chosen = this.ultra.getState().prefs.agentModels[agent.id] ?? null;
        const power = this.ultra.getState().prefs.agentPower;
        const session = this.runtime.open(agent, { ...this.sessionOptions(agent), power, ...(chosen ? { model: chosen } : {}), ...(resume ? { resumeSessionId: resume.sessionId } : {}) }, (e) => this.onEvent(jid, e, agent.id));
        live = { agentId: agent.id, model: chosen, power, session, seenTs: resume?.seenTs ?? 0 };
        this.sessions.set(jid, live);
      }
      this.currentTurn.set(jid, turnId);
      live.seenTs = Math.max(live.seenTs, newestTs);
      await this.watched(jid, live.session.prompt(prompt), live.session);
      this.patchTurn(jid, turnId, (t) => (t.status === "running" ? { status: "done", tools: settle(t.tools) } : {}));
      delete this.history.quota[`${agent.id}|${live.model ?? ""}`]; // it works again
      const sid = this.sessionIds.get(jid);
      if (sid) this.history.sessions[jid] = { agentId: agent.id, model: live.model, power: live.power, sessionId: sid, seenTs: live.seenTs };
    } catch (e) {
      const message = errText(e);
      if (isQuotaError(message)) {
        const chosen = this.ultra.getState().prefs.agentModels[agent.id] ?? "";
        this.history.quota[`${agent.id}|${chosen}`] = { at: Date.now(), message: friendlyError(message, agent) };
      }
      // A resumed session that fails is not offered again.
      if (resume) delete this.history.sessions[jid];
      this.patchTurn(jid, turnId, (t) => (t.status === "cancelled" ? {} : { status: "error", error: friendlyError(message, agent), quota: isQuotaError(message), tools: settle(t.tools, "failed") }));
      // A session that failed mid-turn is not trusted for the next one.
      this.sessions.get(jid)?.session.close();
      this.sessions.delete(jid);
    } finally {
      this.currentTurn.delete(jid);
      if (this.state.busyJid === jid) this.set({ busyJid: null });
      if (this.state.permission?.jid === jid) this.set({ permission: null });
      this.persist();
    }
  }

  /** Session id each scope's agent reported (to resume it next time). */
  private sessionIds = new Map<string, string>();
  private currentTurn = new Map<string, number>();
  private proposed = new Set<string>();
  /** Last time each scope heard from its agent — the watchdog's clock. */
  private lastHeard = new Map<string, number>();

  /** Silence limit: no event at all for this long means the agent is stuck. */
  static IDLE_LIMIT_MS = 120_000;

  private watched(jid: string, turn: Promise<void>, session: AgentSession): Promise<void> {
    this.lastHeard.set(jid, Date.now());
    return new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        // Waiting for the user to answer a permission is not the agent hanging.
        if (this.state.permission?.jid === jid) return this.lastHeard.set(jid, Date.now()), undefined;
        if (Date.now() - (this.lastHeard.get(jid) ?? 0) < AgentController.IDLE_LIMIT_MS) return;
        clearInterval(timer);
        session.cancel();
        reject(new Error(`el agente no responde desde hace ${Math.round(AgentController.IDLE_LIMIT_MS / 1000)} s`));
      }, Math.min(5_000, AgentController.IDLE_LIMIT_MS));
      timer.unref?.();
      turn.then(
        () => (clearInterval(timer), resolve()),
        (e) => (clearInterval(timer), reject(e))
      );
    });
  }
  private toolMeta = new Map<string, { title: string; input: unknown }>();

  private onEvent(jid: string, e: AgentEvent, agentId?: string): void {
    this.lastHeard.set(jid, Date.now());
    if (e.type === "session") this.sessionIds.set(jid, e.sessionId);
    if (e.type === "models" && agentId) {
      this.set((s) => ({ models: { ...s.models, [agentId]: { phase: "ready", list: e.models, current: e.current } } }));
      return;
    }
    const turnId = this.currentTurn.get(jid);
    if (turnId === undefined) return;
    switch (e.type) {
      case "text":
        return this.patchTurn(jid, turnId, (t) => ({ text: t.text + e.text, answeredAt: t.answeredAt ?? Date.now() }));
      case "thought":
        return this.patchTurn(jid, turnId, (t) => ({ thinking: (t.thinking + (t.thinking && !t.thinking.endsWith("\n") && /^[A-ZÁÉÍÓÚ*#]/.test(e.text) ? "\n" : "") + e.text).slice(-6000) }));
      case "tool": {
        // Updates may omit the title/input the start carried.
        const meta = this.toolMeta.get(e.id) ?? { title: e.title, input: e.input };
        if (e.title) meta.title = e.title;
        if (e.input !== undefined) meta.input = e.input;
        this.toolMeta.set(e.id, meta);
        const label = toolLabel(meta.title, meta.input);
        this.patchTurn(jid, turnId, (t) => {
          const exists = t.tools.some((x) => x.id === e.id);
          const step: ToolStep = { id: e.id, label, status: e.status };
          return { tools: exists ? t.tools.map((x) => (x.id === e.id ? step : x)) : [...t.tools, step] };
        });
        const loaded: ChatMessage[] = this.ultra.getState().conversations[jid]?.messages ?? [];
        const ids = readIdsFrom(meta.title, meta.input, e.output, loaded);
        const draft = draftFrom(meta.title, meta.input);
        // Each proposal tool call adds a card once (updates repeat the call).
        const proposal = e.status !== "failed" && !this.proposed.has(e.id) ? proposalFrom(waconTool(meta.title), meta.input) : null;
        if (proposal) {
          this.proposed.add(e.id);
          this.patchChat(jid, (c) => ({ proposals: [...c.proposals, { ...proposal, chatJid: proposal.chatJid ?? (jid === HOME ? null : jid) }].slice(-20) }));
        }
        // A draft from home names its chat; one from a chat panel belongs to that chat.
        if (ids.length || draft) this.patchChat(jid, (c) => ({ readIds: mergeIds(c.readIds, ids), ...(draft ? { draft: { ...draft, chatJid: jid === HOME ? draft.chatJid : jid } } : {}) }));
        return;
      }
      case "permission": {
        const session = this.sessions.get(jid)?.session;
        const auto = autoApproval(e.title, e.options);
        if (auto) return session?.answerPermission(e.requestId, auto);
        // Anything else (its own MCP servers, a command, a file) is the user's
        // call: the agent keeps all its powers, and asks.
        return this.set({ permission: { jid, requestId: e.requestId, title: e.title, options: e.options } });
      }
      case "usage":
        return this.patchChat(jid, (c) => ({
          usage: {
            inputTokens: (c.usage?.inputTokens ?? 0) + (e.inputTokens ?? 0),
            outputTokens: (c.usage?.outputTokens ?? 0) + (e.outputTokens ?? 0),
            costUsd: e.costUsd === undefined ? (c.usage?.costUsd ?? null) : (c.usage?.costUsd ?? 0) + e.costUsd,
          },
        }));
      case "error":
        return this.patchTurn(jid, turnId, () => ({ error: e.message }));
      default:
        return;
    }
  }

  // ── controls ─────────────────────────────────────────────
  answerPermission(optionId: string | null): void {
    const p = this.state.permission;
    if (!p) return;
    this.set({ permission: null });
    try {
      this.sessions.get(p.jid)?.session.answerPermission(p.requestId, optionId);
    } catch (e) {
      this.ultra.inform(`No pude responder al agente: ${errText(e)}`, "error");
    }
  }

  cancel(): void {
    const jid = this.state.busyJid;
    if (!jid) return;
    const turnId = this.currentTurn.get(jid);
    if (turnId !== undefined) this.patchTurn(jid, turnId, (t) => ({ status: "cancelled", tools: settle(t.tools, "failed") }));
    try {
      this.sessions.get(jid)?.session.cancel();
    } catch {
      // the finally in ask() still clears the busy state
    }
    if (this.state.permission?.jid === jid) this.set({ permission: null });
  }

  /** The next agenda proposal, removed from the queue (accept or discard). */
  takeProposal(jid: string): AgendaProposal | null {
    const p = this.state.chats[jid]?.proposals[0] ?? null;
    if (p) this.patchChat(jid, (c) => ({ proposals: c.proposals.slice(1) }));
    return p;
  }

  /** Take the draft out of the panel (to put it in the composer). */
  takeDraft(jid: string): Draft | null {
    const d = this.state.chats[jid]?.draft ?? null;
    if (d) this.patchChat(jid, () => ({ draft: null }));
    return d;
  }

  /** Send the draft as-is — the user's explicit decision, never the agent's. */
  async sendDraft(jid: string): Promise<void> {
    const d = this.takeDraft(jid);
    if (!d) return;
    if (jid === HOME || this.ultra.getState().openJid !== jid) return this.ultra.inform("Abre ese chat para enviar el borrador (Tab)");
    await this.ultra.sendText(d.text, d.replyTo ?? undefined);
  }

  /** Forget the conversation with the agent about this chat. */
  reset(jid: string): void {
    this.sessions.get(jid)?.session.close();
    this.sessions.delete(jid);
    delete this.history.sessions[jid];
    this.patchChat(jid, () => emptyChat());
    this.persist();
  }

  stop(): void {
    for (const s of this.sessions.values()) {
      try {
        s.session.close();
      } catch {
        // closing on exit is best effort
      }
    }
    this.sessions.clear();
  }
}

function mergeIds(a: string[], b: string[]): string[] {
  if (b.length === 0) return a;
  return [...new Set([...a, ...b])].slice(-400);
}

function settle(tools: ToolStep[], to: ToolStep["status"] = "done"): ToolStep[] {
  return tools.map((t) => (t.status === "running" ? { ...t, status: to } : t));
}

/** Turn the usual failures into something the user can act on. */
export function friendlyError(message: string, agent: DetectedAgent): string {
  const m = message.toLowerCase();
  if (/auth|login|log in|credential|api key|unauthori[sz]ed|401/.test(m)) return `${agent.name} necesita iniciar sesión. Ciérralo aquí y ejecuta \`${agent.id}\` en una terminal para entrar; luego vuelve a intentarlo.`;
  if (/no responde/.test(m)) return `${agent.name} dejó de responder. Prueba de nuevo o cambia de agente (Ctrl+L).`;
  if (/enoent|not found|no se encontr/.test(m)) return `No encontré ${agent.name} en este equipo. Ctrl+A → r para volver a buscar agentes.`;
  if (/high demand|overloaded|capacity|503|unavailable/.test(m)) return `${agent.name}: este modelo está saturado ahora mismo.`;
  if (/rate|quota|429|limit|exhausted|resets/.test(m)) return `${agent.name} alcanzó su límite de uso${/resets?\s+([^·.]+)/i.exec(message)?.[1] ? ` (se renueva ${/resets?\s+([^·.]+)/i.exec(message)![1]!.trim()})` : ""}.`;
  return `${agent.name}: ${message.slice(0, 300)}`;
}
