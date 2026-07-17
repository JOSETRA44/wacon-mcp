import { describe, it, expect } from "vitest";
import { Store } from "../src/core/store.js";
import { WatchRegistry } from "../src/core/watch.js";
import { ProactiveScheduler } from "../src/core/scheduler.js";

describe("calendar events & tasks", () => {
  it("creates events and finds due ones", () => {
    const store = new Store(":memory:");
    const past = store.createEvent({ title: "Reunión María", startTs: Date.now() + 60_000, notifyTs: Date.now() - 1000 });
    const future = store.createEvent({ title: "Dentista", startTs: Date.now() + 86_400_000, notifyTs: Date.now() + 80_000_000 });
    const due = store.dueEvents();
    expect(due.map((e) => e.id)).toContain(past.id);
    expect(due.map((e) => e.id)).not.toContain(future.id);
    store.close();
  });

  it("does not re-report fired events", () => {
    const store = new Store(":memory:");
    const e = store.createEvent({ title: "X", startTs: Date.now(), notifyTs: Date.now() - 1000 });
    expect(store.dueEvents()).toHaveLength(1);
    store.setEventStatus(e.id, "fired");
    expect(store.dueEvents()).toHaveLength(0);
    store.close();
  });

  it("tasks: create, list pending, complete", () => {
    const store = new Store(":memory:");
    const t = store.createTask({ title: "Comprar pan" });
    expect(store.listTasks(false)).toHaveLength(1);
    expect(store.completeTask(t.id)).toBe(true);
    expect(store.listTasks(false)).toHaveLength(0);
    expect(store.listTasks(true)).toHaveLength(1);
    store.close();
  });
});

describe("ProactiveScheduler", () => {
  it("emits a trigger for a due event, exactly once", () => {
    const store = new Store(":memory:");
    const watch = new WatchRegistry(store);
    const scheduler = new ProactiveScheduler(store, watch, 60);
    store.createEvent({ chatJid: "maria@s.whatsapp.net", title: "Cita 5pm", startTs: Date.now() + 3600_000, notifyTs: Date.now() - 1000 });

    expect(scheduler.tick()).toBe(1);
    expect(scheduler.tick()).toBe(0); // already fired, not emitted again
    store.close();
  });

  it("a waiting agent is woken by the trigger", async () => {
    const store = new Store(":memory:");
    const watch = new WatchRegistry(store);
    const scheduler = new ProactiveScheduler(store, watch, 60);
    store.createEvent({ chatJid: "juan@s.whatsapp.net", title: "Llamar a Juan", startTs: Date.now() + 600_000, notifyTs: Date.now() - 1000 });

    const pending = watch.waitForTriggers({ timeoutMs: 3000 });
    setTimeout(() => scheduler.tick(), 30);
    const r = await pending;
    expect(r.triggers).toHaveLength(1);
    expect(r.triggers[0]!.title).toBe("Llamar a Juan");
    expect(r.triggers[0]!.chatJid).toBe("juan@s.whatsapp.net");
    store.close();
  });

  it("cursor prevents re-delivering the same trigger", async () => {
    const store = new Store(":memory:");
    const watch = new WatchRegistry(store);
    store.createEvent({ title: "E1", startTs: Date.now(), notifyTs: Date.now() - 1 });
    const scheduler = new ProactiveScheduler(store, watch, 60);
    scheduler.tick();
    const first = await watch.waitForTriggers({ sinceTrigger: 0, timeoutMs: 10 });
    expect(first.triggers).toHaveLength(1);
    const again = await watch.waitForTriggers({ sinceTrigger: first.triggerCursor, timeoutMs: 30 });
    expect(again.triggers).toHaveLength(0);
    store.close();
  });
});
