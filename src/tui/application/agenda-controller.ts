import { buildAgenda, type AgendaItem, type AgendaProposal, type AgendaSection } from "../domain/agenda.js";
import type { AgendaData, AgendaGateway } from "./ports.js";

/**
 * The Agenda's use cases: what is coming up, marking things done, and adding
 * what the user (or, with their OK, the AI) wants to remember. Same contract
 * as the other controllers: a store for useSyncExternalStore, and methods
 * that never throw — failures become a message through `inform`.
 */

export interface AgendaState {
  phase: "idle" | "loading" | "ready";
  data: AgendaData;
}

const EMPTY: AgendaData = { events: [], tasks: [], staleSuggestions: 0, commitments: [] };
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class AgendaController {
  private state: AgendaState = { phase: "idle", data: EMPTY };
  private listeners = new Set<() => void>();

  constructor(
    private readonly gw: AgendaGateway,
    private readonly inform: (text: string, tone?: "info" | "success" | "error") => void,
    private readonly now: () => number = Date.now
  ) {}

  getState = (): AgendaState => this.state;
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  private set(p: Partial<AgendaState>): void {
    this.state = { ...this.state, ...p };
    for (const l of this.listeners) l();
  }

  sections(): AgendaSection[] {
    return buildAgenda(this.state.data.events, this.state.data.tasks, this.now());
  }

  async refresh(): Promise<void> {
    if (this.state.phase === "idle") this.set({ phase: "loading" });
    try {
      this.set({ phase: "ready", data: await this.gw.agenda(90) });
    } catch (e) {
      this.set({ phase: "ready" });
      this.inform(`No pude cargar la agenda: ${errText(e)}`, "error");
    }
  }

  /** Add what was proposed — the user's explicit decision. */
  async add(p: AgendaProposal): Promise<boolean> {
    try {
      if (p.kind === "event" && p.when) await this.gw.scheduleEvent({ title: p.title, start: p.when, chat: p.chatJid ?? undefined, notes: p.notes ?? undefined });
      else await this.gw.addTask({ title: p.title, due: p.when ?? undefined, chat: p.chatJid ?? undefined, notes: p.notes ?? undefined });
      this.inform(p.kind === "event" ? `📅 Añadido a tu agenda: ${p.title}` : `☐ Tarea añadida: ${p.title}`, "success");
      await this.refresh();
      return true;
    } catch (e) {
      this.inform(`No pude añadirlo: ${errText(e)}`, "error");
      return false;
    }
  }

  async addTask(title: string): Promise<void> {
    const t = title.trim();
    if (t) await this.add({ kind: "task", title: t, when: null, chatJid: null, notes: null });
  }

  /** Done: an event happened, a task was finished. */
  async complete(item: AgendaItem): Promise<void> {
    try {
      if (item.kind === "event") await this.gw.completeEvent(item.id);
      else await this.gw.completeTask(item.id);
      this.inform(`✓ ${item.title}`, "success");
      await this.refresh();
    } catch (e) {
      this.inform(`No pude marcarlo: ${errText(e)}`, "error");
    }
  }

  async cancel(item: AgendaItem): Promise<void> {
    if (item.kind !== "event") return this.complete(item);
    try {
      await this.gw.cancelEvent(item.id);
      this.inform(`Cancelado: ${item.title}`);
      await this.refresh();
    } catch (e) {
      this.inform(`No pude cancelarlo: ${errText(e)}`, "error");
    }
  }

  async clearStale(): Promise<void> {
    try {
      const n = await this.gw.dismissStaleSuggestions();
      this.inform(`Descarté ${n} sugerencias antiguas`, "success");
      await this.refresh();
    } catch (e) {
      this.inform(`No pude limpiarlas: ${errText(e)}`, "error");
    }
  }
}
