import { describe, it, expect } from "vitest";
import { WatchRegistry } from "../src/core/watch.js";
import { suggestWatchWindow } from "../src/core/activity.js";
import { Store, type MessageRow } from "../src/core/store.js";

const SELF = "5511111@s.whatsapp.net";

function msg(over: Partial<MessageRow> = {}): MessageRow {
  return {
    id: Math.random().toString(36).slice(2),
    chat_jid: "friend@s.whatsapp.net",
    sender_jid: "friend@s.whatsapp.net",
    from_me: 0,
    timestamp: Date.now(),
    text: "hola",
    message_type: "text",
    quoted_id: null,
    ...over,
  };
}

function freshStore(): Store {
  return new Store(":memory:");
}

describe("WatchRegistry triage", () => {
  it("scores direct chats above group noise", async () => {
    const store = freshStore();
    const reg = new WatchRegistry(store);
    reg.ingest(msg({ chat_jid: "friend@s.whatsapp.net" }), SELF);
    reg.ingest(msg({ chat_jid: "group@g.us" }), SELF);
    const events = await reg.wait({ since: 0, timeoutMs: 10 });
    const direct = events.find((e) => e.message.chat_jid.endsWith("@s.whatsapp.net"))!;
    const group = events.find((e) => e.message.chat_jid.endsWith("@g.us"))!;
    expect(direct.priority).toBeGreaterThan(group.priority);
    expect(direct.reasons).toContain("direct-chat");
    store.close();
  });

  it("boosts group messages that mention the user", async () => {
    const store = freshStore();
    const reg = new WatchRegistry(store);
    reg.ingest(msg({ chat_jid: "group@g.us", text: "oigan @5511111 vengan" }), SELF);
    const [event] = await reg.wait({ since: 0, timeoutMs: 10 });
    expect(event!.reasons).toContain("mentions-me");
    expect(event!.priority).toBeGreaterThan(40);
    store.close();
  });

  it("never wakes for the user's own messages", async () => {
    const store = freshStore();
    const reg = new WatchRegistry(store);
    reg.ingest(msg({ from_me: 1 }), SELF);
    expect(await reg.wait({ since: 0, timeoutMs: 10 })).toHaveLength(0);
    store.close();
  });
});

describe("WatchRegistry rules", () => {
  it("filters by keyword ignoring accents and case", async () => {
    const store = freshStore();
    const reg = new WatchRegistry(store);
    const session = reg.start({ keywords: ["reunión"] }, 10, "test");
    reg.ingest(msg({ text: "hay REUNION mañana?" }), SELF);
    reg.ingest(msg({ text: "hola nada mas" }), SELF);
    const events = await reg.wait({ since: 0, sessionId: session.id, timeoutMs: 10 });
    expect(events).toHaveLength(1);
    expect(events[0]!.message.text).toContain("REUNION");
    store.close();
  });

  it("excludes groups unless asked", async () => {
    const store = freshStore();
    const reg = new WatchRegistry(store);
    const session = reg.start({}, 10, "test");
    reg.ingest(msg({ chat_jid: "group@g.us" }), SELF);
    expect(await reg.wait({ since: 0, sessionId: session.id, timeoutMs: 10 })).toHaveLength(0);

    const open = reg.start({ includeGroups: true }, 10, "test");
    expect(await reg.wait({ since: 0, sessionId: open.id, timeoutMs: 10 })).toHaveLength(1);
    store.close();
  });

  it("honors minPriority", async () => {
    const store = freshStore();
    const reg = new WatchRegistry(store);
    const strict = reg.start({ minPriority: 90 }, 10, "test");
    reg.ingest(msg(), SELF);
    expect(await reg.wait({ since: 0, sessionId: strict.id, timeoutMs: 10 })).toHaveLength(0);
    store.close();
  });

  it("expires sessions on their own", () => {
    const store = freshStore();
    const reg = new WatchRegistry(store);
    const session = reg.start({}, 1, "test");
    expect(reg.activeSessions()).toHaveLength(1);
    session.expiresAt = Date.now() - 1;
    expect(reg.activeSessions()).toHaveLength(0);
    store.close();
  });
});

describe("WatchRegistry long-poll", () => {
  it("resolves as soon as a message arrives", async () => {
    const store = freshStore();
    const reg = new WatchRegistry(store);
    const started = Date.now();
    const pending = reg.wait({ timeoutMs: 5000 });
    setTimeout(() => reg.ingest(msg({ text: "llegué" }), SELF), 50);
    const events = await pending;
    expect(events).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(2000); // returned early, not at timeout
    store.close();
  });

  it("times out empty instead of hanging", async () => {
    const store = freshStore();
    const reg = new WatchRegistry(store);
    expect(await reg.wait({ timeoutMs: 60 })).toHaveLength(0);
    store.close();
  });

  it("cursor guarantees no missed and no repeated events", async () => {
    const store = freshStore();
    const reg = new WatchRegistry(store);
    reg.ingest(msg({ text: "uno" }), SELF);
    const first = await reg.wait({ since: 0, timeoutMs: 10 });
    expect(first).toHaveLength(1);

    // Arrives while the agent is away — must not be lost.
    reg.ingest(msg({ text: "dos" }), SELF);
    const second = await reg.wait({ since: first[0]!.seq, timeoutMs: 10 });
    expect(second).toHaveLength(1);
    expect(second[0]!.message.text).toBe("dos");

    // Same cursor again returns nothing new.
    expect(await reg.wait({ since: second[0]!.seq, timeoutMs: 30 })).toHaveLength(0);
    store.close();
  });

  it("releaseAll unblocks waiters on shutdown", async () => {
    const store = freshStore();
    const reg = new WatchRegistry(store);
    const pending = reg.wait({ timeoutMs: 30_000 });
    reg.releaseAll();
    expect(await pending).toHaveLength(0);
    store.close();
  });
});

describe("suggestWatchWindow", () => {
  it("tells the agent not to wait when the slot is dead", () => {
    const store = freshStore();
    const suggestion = suggestWatchWindow(store); // empty history => no traffic ever
    expect(suggestion.recommendedMinutes).toBe(0);
    expect(suggestion.now.level).toBe("dead");
    expect(suggestion.rationale).toContain("tokens");
    store.close();
  });

  it("refuses to recommend a marathon vigil when a better window is coming", () => {
    const store = freshStore();
    const now = new Date();
    // Trickle in the current slot, burst one hour from now: waiting here would
    // take longer than a watch can live, so it should tell us to come back.
    for (let week = 0; week < 8; week++) {
      const base = now.getTime() - week * 7 * 24 * 3600_000;
      if (week % 4 === 0) store.insertMessage(msg({ from_me: 0, timestamp: base, text: `goteo ${week}` }));
      for (let i = 0; i < 12; i++) {
        store.insertMessage(msg({ from_me: 0, timestamp: base + 3600_000 + i * 60_000, text: `pico ${week}-${i}` }));
      }
    }
    const suggestion = suggestWatchWindow(store);
    expect(suggestion.recommendedMinutes).toBe(0);
    expect(suggestion.nextBusyWindow).not.toBeNull();
    expect(suggestion.rationale).toContain("ventana activa");
    store.close();
  });

  it("recommends a bounded window when the slot is busy", () => {
    const store = freshStore();
    // Seed 8 weeks of inbound messages in the current weekday+hour slot.
    const now = new Date();
    for (let week = 0; week < 8; week++) {
      for (let i = 0; i < 10; i++) {
        const t = new Date(now.getTime() - week * 7 * 24 * 3600_000);
        t.setMinutes(i * 5);
        store.insertMessage(msg({ from_me: 0, timestamp: t.getTime(), text: `mensaje ${week}-${i}` }));
      }
    }
    const suggestion = suggestWatchWindow(store);
    expect(suggestion.now.expectedPerHour).toBeGreaterThan(4);
    expect(suggestion.now.level).toBe("busy");
    expect(suggestion.recommendedMinutes).toBeGreaterThan(0);
    expect(suggestion.recommendedMinutes).toBeLessThanOrEqual(60);
    expect(suggestion.forecast).toHaveLength(12);
    store.close();
  });
});
