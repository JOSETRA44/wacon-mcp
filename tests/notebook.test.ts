import { describe, it, expect } from "vitest";
import { Store } from "../src/core/store.js";
import { consultPlaybook } from "../src/knowledge/notebook.js";
import type { NotebooksConfig } from "../src/core/notebooks-config.js";

const JID = "crush@s.whatsapp.net";

const CONFIG: NotebooksConfig = {
  nlmPath: "___definitely_not_a_real_binary___", // force spawn failure → degradation
  timeoutSeconds: 5,
  tags: { seduccion: { notebook: "wacon", purpose: "seducción por chat" } },
};

describe("consultPlaybook orchestration", () => {
  it("does not consult when the chat has no tags", async () => {
    const store = new Store(":memory:");
    const r = await consultPlaybook(store, JID, "quiere salir el viernes", CONFIG);
    expect(r.consulted).toBe(false);
    expect(r.degraded).toBe(false);
    store.close();
  });

  it("does not consult when tags map to no notebook", async () => {
    const store = new Store(":memory:");
    store.tagChat(JID, "sin_mapeo");
    const r = await consultPlaybook(store, JID, "situación", CONFIG);
    expect(r.consulted).toBe(false);
    expect(r.note).toContain("notebook");
    store.close();
  });

  it("degrades gracefully when nlm is unavailable (never throws)", async () => {
    const store = new Store(":memory:");
    store.tagChat(JID, "seduccion");
    const r = await consultPlaybook(store, JID, "quiere que la convenza de salir", CONFIG);
    expect(r.consulted).toBe(true);
    expect(r.degraded).toBe(true);
    expect(r.note).toContain("conocimiento general"); // instructs the agent to proceed anyway
    store.close();
  });

  it("returns cached advice without spawning nlm", async () => {
    const store = new Store(":memory:");
    store.tagChat(JID, "seduccion");
    // Pre-seed the cache with the exact question consultPlaybook will build.
    // We compute the hash the same way (tag|situation lowercased) via a first
    // degraded call to learn the question, then cache under that situation.
    const situation = "primera cita el sábado";
    // Manually cache using the same situation hash the module derives.
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha1").update(`seduccion|${situation.toLowerCase().trim()}`).digest("hex").slice(0, 16);
    store.cachePlaybook({ tag: "seduccion", situationHash: hash, question: "q", answer: "ofrece atención genuina primero", citationsJson: "[]" });

    const r = await consultPlaybook(store, JID, situation, CONFIG);
    expect(r.consulted).toBe(true);
    expect(r.degraded).toBe(false);
    expect(r.fromCache).toBe(true);
    expect(r.advice).toContain("atención genuina");
    store.close();
  });
});
