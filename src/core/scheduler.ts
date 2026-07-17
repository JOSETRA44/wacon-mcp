import type { Store } from "./store.js";
import type { WatchRegistry } from "./watch.js";

/**
 * The proactive engine. A plain interval (no cron dependency) scans for
 * calendar events whose notify time has arrived, marks them fired, and emits a
 * trigger into the attention bus. An agent long-polling wait_for_triggers wakes
 * up and DECIDES whether to act — the daemon never sends on its own.
 */
export class ProactiveScheduler {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private store: Store,
    private watch: WatchRegistry,
    private pollSeconds: number
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.pollSeconds * 1000);
    this.timer.unref?.(); // don't keep the process alive just for this
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Exposed for tests: fire all currently-due events exactly once. */
  tick(): number {
    const due = this.store.dueEvents();
    for (const ev of due) {
      // Mark fired FIRST so a slow/again tick never double-emits.
      this.store.setEventStatus(ev.id, "fired");
      this.watch.emitTrigger({
        kind: "event",
        eventId: ev.id,
        chatJid: ev.chat_jid,
        chatName: ev.chat_jid ? this.store.resolveDisplayName(ev.chat_jid) : null,
        title: ev.title,
        startTs: ev.start_ts,
        minutesUntilStart: Math.round((ev.start_ts - Date.now()) / 60_000),
        notes: ev.notes,
        firedAt: Date.now(),
      });
    }
    return due.length;
  }
}
