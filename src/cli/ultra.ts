import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DaemonClient } from "../daemon/client.js";
import { shortTime, resolveTarget, mediaKindOf, openWithSystemViewer, type ChatTarget } from "./chat-core.js";

/**
 * `wacon chat ultra` — the full-screen WhatsApp-Web-style app.
 *
 * Pure presentation over the daemon: every bit of WhatsApp behaviour comes from
 * DaemonClient (listChats/inbox/readMessages/send/waitForMessages/…). This file
 * only lays out panels and wires keys. neo-blessed is imported lazily by the
 * caller so nothing else in the CLI pays for it.
 */

// neo-blessed ships no types; we type just what we touch.
type BlessedWidget = {
  key: (keys: string[], cb: () => void) => void;
  on: (ev: string, cb: (...a: unknown[]) => void) => void;
  focus: () => void;
  setContent: (s: string) => void;
  setLabel: (s: string) => void;
  setItems: (items: string[]) => void;
  select: (i: number) => void;
  add: (line: string) => void;
  log: (line: string) => void;
  setValue: (s: string) => void;
  getValue: () => string;
  clearValue: () => void;
  readInput: (cb: (err: unknown, value?: string) => void) => void;
  scroll: (n: number) => void;
  setScrollPerc: (n: number) => void;
  hide: () => void;
  show: () => void;
  selected?: number;
};
type Blessed = {
  screen: (opts: Record<string, unknown>) => BlessedWidget & { render: () => void; destroy: () => void; append: (w: unknown) => void; key: (k: string[], cb: () => void) => void; readonly focused: unknown };
  box: (opts: Record<string, unknown>) => BlessedWidget;
  list: (opts: Record<string, unknown>) => BlessedWidget;
  log: (opts: Record<string, unknown>) => BlessedWidget;
  textbox: (opts: Record<string, unknown>) => BlessedWidget;
};

interface ChatRow {
  jid: string;
  name: string;
  unread: number;
  lastTs: number;
  preview: string;
}

const firstName = (name: string) => name.split(" ")[0] ?? name;

export async function runUltra(client: DaemonClient, initialQuery?: string): Promise<void> {
  if (!process.stdout.isTTY) {
    process.stderr.write("El modo ultra necesita una terminal interactiva. Usa `wacon chat` para el cliente ligero.\n");
    process.exit(1);
  }

  let blessed: Blessed;
  try {
    const mod = (await import("neo-blessed")) as { default?: Blessed } & Blessed;
    blessed = mod.default ?? mod;
  } catch {
    process.stderr.write(
      "El modo ultra requiere el paquete 'neo-blessed'.\nInstálalo con `npm i -g neo-blessed`, o usa `wacon chat` (cliente ligero).\n"
    );
    process.exit(1);
  }

  // ignoreLocked lets Ctrl+C always reach the quit handler even while the
  // input box is actively reading a message (blessed otherwise swallows
  // screen-level key bindings during that window — see screen.grabKeys).
  const screen = blessed.screen({
    smartCSR: true,
    title: "Wacon",
    fullUnicode: true,
    autoPadding: true,
    ignoreLocked: ["C-c"],
  });

  const chatList = blessed.list({
    parent: screen,
    label: " Chats ",
    top: 0,
    left: 0,
    width: "32%",
    height: "100%-1",
    border: { type: "line" },
    keys: true,
    vi: true,
    mouse: true,
    style: { selected: { bg: "green", fg: "black" }, border: { fg: "gray" }, label: { fg: "cyan" } },
    tags: true,
  });

  const convo = blessed.log({
    parent: screen,
    label: " Conversación ",
    top: 0,
    left: "32%",
    width: "68%",
    height: "100%-4",
    border: { type: "line" },
    scrollable: true,
    alwaysScroll: true,
    scrollbar: { ch: " ", style: { bg: "gray" } },
    keys: true,
    vi: true,
    mouse: true,
    tags: true,
    style: { border: { fg: "gray" }, label: { fg: "cyan" } },
  });

  const input = blessed.textbox({
    parent: screen,
    label: " Mensaje (Enter envía · Ctrl+N/P cambia chat · Esc lista · ? ayuda) ",
    bottom: 1,
    left: "32%",
    width: "68%",
    height: 3,
    border: { type: "line" },
    inputOnFocus: false,
    keys: true,
    style: { border: { fg: "gray" }, label: { fg: "gray" } },
  });

  const statusBar = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    width: "100%",
    height: 1,
    tags: true,
    style: { bg: "black" },
  });

  // ── state ────────────────────────────────────────────────
  let rows: ChatRow[] = [];
  let filtered: ChatRow[] = [];
  let target: ChatTarget | null = null;
  let activeJid: string | null = null; // mirror of target.jid for the live-feed closure
  let cursor = 0; // watch cursor for the live feed
  let receipts: "on" | "off" | "unknown" = "unknown";
  const mediaSlots: { messageId: string; kind: "image" | "audio" | "other" }[] = [];
  let running = true;

  const setStatus = (text: string) => {
    statusBar.setContent(` {cyan-fg}Wacon{/} · ${text} · {gray-fg}Ctrl+N/P chat · Ctrl+K buscar · Ctrl+O adjuntar · Ctrl+C salir{/}`);
    screen.render();
  };

  const renderList = () => {
    chatList.setItems(
      filtered.map((r) => {
        const badge = r.unread > 0 ? `{yellow-fg}(${r.unread}){/}` : "";
        const mark = target && r.jid === target.jid ? "{green-fg}›{/} " : "  ";
        return `${mark}${r.name.slice(0, 20).padEnd(20)} ${badge}`;
      })
    );
    screen.render();
  };

  const loadChats = async () => {
    // WhatsApp Web orders by conversation recency, full stop — unread status
    // is a badge, not a sort key. The old code put pending (unanswered)
    // chats first with a fake `lastTs: Date.now()`, which is why the order
    // looked like "most unread wins": every pending chat tied for newest
    // regardless of when it actually last spoke. Fixed by merging both
    // sources into one map keyed by jid and sorting by real timestamp.
    const [inbox, chats] = await Promise.all([
      client.inbox(60, false).catch(() => []),
      client.listChats(80).catch(() => []),
    ]);
    const byJid = new Map<string, ChatRow>();
    for (const c of chats as { jid: string; display_name: string | null; last_message_ts: number | null }[]) {
      byJid.set(c.jid, { jid: c.jid, name: c.display_name ?? c.jid, unread: 0, lastTs: c.last_message_ts ?? 0, preview: "" });
    }
    for (const p of inbox as { chat: string; name: string | null; unansweredCount: number; lastMessage: string | null; lastTimestamp: number }[]) {
      const prev = byJid.get(p.chat);
      byJid.set(p.chat, {
        jid: p.chat,
        name: p.name ?? prev?.name ?? p.chat,
        unread: p.unansweredCount,
        lastTs: p.lastTimestamp || prev?.lastTs || 0,
        preview: p.lastMessage ?? prev?.preview ?? "",
      });
    }
    rows = [...byJid.values()].sort((a, b) => b.lastTs - a.lastTs);
    filtered = rows;
    renderList();
  };

  // Tracks the last speaker/day painted so consecutive lines from the same
  // person can group together (no repeated name) with a blank line at every
  // turn change — this is what makes the log read like a real chat instead
  // of a flat, undifferentiated stream.
  let lastSpeaker: "yo" | "them" | null = null;
  let lastDay: string | null = null;
  const dayLabel = (ts: number) => new Date(ts).toLocaleDateString("es-PE", { day: "2-digit", month: "short" });

  const renderLine = (m: { from_me?: number; text: string | null; timestamp: number; message_type?: string; id?: string }) => {
    const day = dayLabel(m.timestamp);
    if (day !== lastDay) {
      convo.log(`{gray-fg}── ${day} ──{/}`);
      lastDay = day;
      lastSpeaker = null;
    }
    const speaker: "yo" | "them" = m.from_me ? "yo" : "them";
    if (speaker !== lastSpeaker) {
      if (lastSpeaker !== null) convo.log("");
      lastSpeaker = speaker;
    }
    const who = speaker === "yo" ? "{green-fg}{bold}yo{/}{/}" : `{cyan-fg}{bold}${target ? firstName(target.name) : "?"}{/}{/}`;
    let body = m.text ?? `{gray-fg}(${m.message_type ?? "media"}){/}`;
    const kind = mediaKindOf(m.message_type, m.text);
    if (kind && m.id) {
      mediaSlots.push({ messageId: m.id, kind });
      body = `${body} {yellow-fg}[Enter=ver ${mediaSlots.length}]{/}`;
    }
    convo.log(`{gray-fg}${shortTime(m.timestamp)}{/}  ${who}  ${body}`);
  };

  const openChat = async (t: ChatTarget) => {
    target = t;
    activeJid = t.jid;
    mediaSlots.length = 0;
    lastSpeaker = null;
    lastDay = null;
    convo.setLabel(` ${t.name} `);
    convo.setContent("");
    const msgs = await client.readMessages(t.jid, 30);
    for (const m of msgs.slice().reverse()) renderLine(m);
    convo.setScrollPerc(100);
    await client.markRead(t.jid).catch(() => undefined);
    const row = rows.find((r) => r.jid === t.jid);
    if (row) row.unread = 0;
    renderList();
    setStatus(`${t.name} · vistos: ${receipts}`);
    armInput();
  };

  // ── live feed (reuses the long-poll) ─────────────────────
  const feed = (async () => {
    while (running) {
      try {
        const r = (await client.waitForMessages({ since: cursor, timeoutSeconds: 50 })) as {
          cursor: number;
          events: { id: string; chat: string; chatName: string | null; text: string | null; at: string; type: string }[];
        };
        cursor = r.cursor;
        for (const e of r.events) {
          if (!running) break;
          if (activeJid !== null && e.chat === activeJid) {
            renderLine({ from_me: 0, text: e.text, timestamp: new Date(e.at).getTime(), message_type: e.type, id: e.id });
            convo.setScrollPerc(100);
            await client.markRead(activeJid, 5).catch(() => undefined);
            const row = rows.find((x) => x.jid === e.chat);
            if (row) row.lastTs = Date.now();
          } else {
            // Bump the sender to the top of the list (real recency, matching
            // how the list is sorted) with an unread badge.
            const row = rows.find((x) => x.jid === e.chat);
            if (row) {
              row.unread += 1;
              row.lastTs = Date.now();
              rows = [row, ...rows.filter((x) => x.jid !== row.jid)];
            } else {
              rows.unshift({ jid: e.chat, name: e.chatName ?? e.chat, unread: 1, lastTs: Date.now(), preview: e.text ?? "" });
            }
            filtered = rows;
            renderList();
          }
        }
      } catch {
        if (running) await new Promise((res) => setTimeout(res, 2000));
      }
    }
  })();

  // ── actions ──────────────────────────────────────────────
  const sendCurrent = async (text: string) => {
    if (!target) return;
    const r = await client.send(target.jid, text, "cli-ultra");
    if (r.sent) {
      renderLine({ from_me: 1, text, timestamp: Date.now() });
      convo.setScrollPerc(100);
    } else {
      convo.log(`{yellow-fg}✖ no enviado: ${r.reason ?? "bloqueado"}{/}`);
    }
    screen.render();
  };

  /**
   * Drives the persistent input bar. `inputOnFocus` is deliberately off:
   * blessed's own auto-submit path calls `screen.rewindFocus()` on every
   * Enter/blur, which fought our manual focus juggling and was the actual
   * cause of doubled keystrokes and being unable to switch chats — each
   * send/refocus cycle stacked another focus-history entry until navigation
   * became unpredictable. Driving `readInput` explicitly, once per turn,
   * keeps exactly one listener alive at a time.
   */
  const armInput = () => {
    input.readInput((_err, value) => {
      input.clearValue();
      screen.render();
      if (value && value.trim()) void sendCurrent(value.trim());
      if (screen.focused === input) armInput();
    });
  };

  const viewMedia = async (n: number) => {
    const slot = mediaSlots[n - 1];
    if (!slot || !target) return;
    try {
      if (slot.kind === "audio") {
        const res = await client.transcribeAudio(target.jid, slot.messageId);
        if ("guidance" in res) convo.log(`{yellow-fg}✖ ${res.guidance}{/}`);
        else if (res.mode === "transcript") convo.log(`{cyan-fg}🎧 ${res.text}{/}`);
        else {
          const dir = join(tmpdir(), "wacon-media");
          mkdirSync(dir, { recursive: true });
          const file = join(dir, `${slot.messageId}.ogg`);
          writeFileSync(file, Buffer.from(res.base64, "base64"));
          openWithSystemViewer(file);
          convo.log(`{gray-fg}abriendo audio…{/}`);
        }
      } else {
        const res = await client.viewImage(target.jid, slot.messageId);
        if ("guidance" in res) convo.log(`{yellow-fg}✖ ${res.guidance}{/}`);
        else {
          const dir = join(tmpdir(), "wacon-media");
          mkdirSync(dir, { recursive: true });
          const ext = (res.mimetype.split("/")[1] ?? "jpg").replace(/[^a-z0-9]/gi, "") || "jpg";
          const file = join(dir, `${slot.messageId}.${ext}`);
          writeFileSync(file, Buffer.from(res.base64, "base64"));
          openWithSystemViewer(file);
          convo.log(`{gray-fg}abriendo imagen…{/}`);
          if (res.description) convo.log(`{cyan-fg}👁 ${res.description}{/}`);
        }
      }
    } catch {
      convo.log("{yellow-fg}✖ no pude abrir ese archivo{/}");
    }
    screen.render();
  };

  /** Prompt for a line of text using a transient centered box. */
  const prompt = (labelText: string): Promise<string | null> =>
    new Promise((resolve) => {
      const box = blessed.textbox({
        parent: screen,
        label: ` ${labelText} `,
        top: "center",
        left: "center",
        width: "60%",
        height: 3,
        border: { type: "line" },
        inputOnFocus: true,
        style: { border: { fg: "cyan" } },
      });
      box.focus();
      box.readInput((_e, value) => {
        (box as unknown as { destroy: () => void }).destroy();
        if (target) armInput();
        screen.render();
        resolve(value && value.trim() ? value.trim() : null);
      });
      screen.render();
    });

  const applyFilter = (q: string) => {
    const needle = q.toLowerCase();
    filtered = needle ? rows.filter((r) => r.name.toLowerCase().includes(needle)) : rows;
    renderList();
  };

  // ── key bindings ─────────────────────────────────────────
  // blessed's List already fires 'select' on Enter (see list.js's
  // `enterSelected`) — a separate chatList.key(["enter"]) handler used to
  // double-fire openChat() on every Enter press. One listener now.
  chatList.on("select", (_item: unknown, index: unknown) => {
    const r = filtered[Number(index)];
    if (r) void openChat({ jid: r.jid, name: r.name });
  });

  // Jump to the list with the currently-open chat highlighted, not always
  // index 0 — so arrow keys continue naturally from wherever you are.
  const focusList = () => {
    const idx = target ? filtered.findIndex((r) => r.jid === target!.jid) : -1;
    if (idx >= 0) chatList.select(idx);
    chatList.focus();
  };
  input.key(["escape", "tab"], focusList);
  chatList.key(["tab"], () => armInput());

  // Enter on the conversation pane opens the most recent media.
  convo.key(["enter"], () => {
    if (mediaSlots.length > 0) void viewMedia(mediaSlots.length);
  });

  // Cycle chats directly without ever leaving the keyboard flow — this is
  // the main "cambiar de chat" fix: you no longer have to blur the input,
  // find the list, arrow around and Enter just to hop to the next
  // conversation. Ctrl+N/Ctrl+P are non-typable, so — like Ctrl+F/O/S — they
  // work both while browsing the list AND while composing a message.
  const stepChat = (dir: 1 | -1) => {
    if (filtered.length === 0) return;
    const idx = target ? filtered.findIndex((r) => r.jid === target!.jid) : -1;
    const next = filtered[(idx + dir + filtered.length) % filtered.length];
    if (next) void openChat({ jid: next.jid, name: next.name });
  };
  const nextChat = () => stepChat(1);
  const prevChat = () => stepChat(-1);
  screen.key(["C-n"], nextChat);
  screen.key(["C-p"], prevChat);
  input.key(["C-n"], nextChat);
  input.key(["C-p"], prevChat);

  // '/' opens the chat search/jump prompt but only from the list (it's a
  // typable character, must not hijack a literal "/" in a message). Ctrl+K
  // is the same prompt, reachable even while composing.
  const jumpToChat = () => {
    void prompt("buscar chat").then((q) => applyFilter(q ?? ""));
  };
  screen.key(["/"], jumpToChat);
  screen.key(["C-k"], jumpToChat);
  input.key(["C-k"], jumpToChat);

  const searchConvo = () => {
    if (!target) return;
    void prompt("buscar en la conversación").then(async (q) => {
      if (!q) return;
      const hits = await client.searchMessages(q, target!.jid, 15);
      convo.log(`{gray-fg}── ${hits.length} resultados para "${q}" ──{/}`);
      for (const h of hits) convo.log(`{gray-fg}${shortTime(h.timestamp)}{/} ${h.from_me ? "{green-fg}yo{/}" : "{cyan-fg}ellos{/}"} ${h.snippet}`);
      screen.render();
    });
  };
  const attachFile = () => {
    if (!target) return;
    void prompt("ruta del archivo a enviar").then(async (path) => {
      if (!path) return;
      const r = await client.sendFile(target!.jid, path, { clientName: "cli-ultra" });
      if ("guidance" in r) convo.log(`{yellow-fg}✖ ${r.guidance}{/}`);
      else if (r.sent) renderLine({ from_me: 1, text: `[${r.kind}: ${r.fileName}]`, timestamp: Date.now() });
      else convo.log(`{yellow-fg}✖ no enviado: ${r.reason ?? "bloqueado"}{/}`);
      screen.render();
    });
  };
  const attachSticker = () => {
    if (!target) return;
    void prompt("sticker (mood: risa, carino, saludo, ok, disculpa)").then(async (mood) => {
      if (!mood) return;
      const listed = (await client.listStickers({ mood, chat: target!.jid, limit: 1 })) as { stickers: { id: string }[] };
      const sticker = listed.stickers[0];
      if (!sticker) {
        convo.log(`{gray-fg}sin stickers para "${mood}"{/}`);
      } else {
        const r = await client.sendSticker(target!.jid, sticker.id, "cli-ultra");
        convo.log("guidance" in r ? `{yellow-fg}✖ ${r.guidance}{/}` : `{gray-fg}${shortTime(Date.now())} {green-fg}yo{/} [sticker]{/}`);
      }
      screen.render();
    });
  };
  // These use Ctrl-combinations (not typable text), so they're bound on
  // both the screen AND the input box — otherwise they'd only work while
  // browsing the chat list, since grabKeys suppresses screen-level keys
  // while the input is actively reading a message.
  screen.key(["C-f"], searchConvo);
  screen.key(["C-o"], attachFile);
  screen.key(["C-s"], attachSticker);
  input.key(["C-f"], searchConvo);
  input.key(["C-o"], attachFile);
  input.key(["C-s"], attachSticker);

  const HELP =
    "{bold}Wacon ultra{/}\n\n" +
    "  Ctrl+N/P  chat siguiente / anterior (funciona escribiendo)\n" +
    "  Ctrl+K    buscar/saltar a un chat (funciona escribiendo)\n" +
    "  Esc/Tab   ir a la lista de chats\n" +
    "  ↑↓        moverse en la lista\n" +
    "  Enter     abrir chat / enviar / ver media\n" +
    "  /         buscar un chat (solo desde la lista)\n" +
    "  Ctrl+F    buscar dentro de la conversación\n" +
    "  Ctrl+O    adjuntar un archivo (imagen, PDF, audio…)\n" +
    "  Ctrl+S    enviar un sticker\n" +
    "  Ctrl+C    salir\n\n" +
    "  {gray-fg}(pulsa cualquier tecla para cerrar){/}";
  const showHelp = () => {
    const help = blessed.box({
      parent: screen,
      label: " Ayuda ",
      top: "center",
      left: "center",
      width: "50%",
      height: 15,
      border: { type: "line" },
      tags: true,
      content: HELP,
      style: { border: { fg: "cyan" } },
    });
    help.focus();
    help.key(["escape", "enter", "space", "q", "?", "f1"], () => {
      (help as unknown as { destroy: () => void }).destroy();
      if (target) armInput();
      screen.render();
    });
    screen.render();
  };
  screen.key(["?", "f1"], showHelp);

  const quit = () => {
    running = false;
    screen.destroy();
    process.exit(0);
  };
  screen.key(["C-c", "q"], quit);

  // ── boot ─────────────────────────────────────────────────
  receipts = await client.readReceiptsMode().catch(() => "unknown" as const);
  cursor = ((await client.watchStatus().catch(() => ({ cursor: 0 }))) as { cursor: number }).cursor;
  await loadChats();
  setStatus(`${rows.length} chats · vistos: ${receipts}`);

  const start = initialQuery ? await resolveTarget(client, initialQuery) : null;
  if (start) await openChat(start);
  else {
    chatList.focus();
    chatList.select(0);
  }
  screen.render();

  await feed; // keep the process alive until quit()
}
