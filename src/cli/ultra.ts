import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir, homedir } from "node:os";
import type { DaemonClient } from "../daemon/client.js";
import { shortTime, resolveTarget, mediaKindOf, openWithSystemViewer, friendlyName, unquotePath, type ChatTarget } from "./chat-core.js";
import { nextTip, hasSeen, markSeen, ULTRA_TIPS } from "./tips.js";

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
type BlessedFileManager = BlessedWidget & {
  refresh: (cb?: (err: unknown) => void) => void;
  destroy: () => void;
};
type Blessed = {
  screen: (opts: Record<string, unknown>) => BlessedWidget & { render: () => void; destroy: () => void; append: (w: unknown) => void; key: (k: string[], cb: () => void) => void; readonly focused: unknown };
  box: (opts: Record<string, unknown>) => BlessedWidget;
  list: (opts: Record<string, unknown>) => BlessedWidget;
  log: (opts: Record<string, unknown>) => BlessedWidget;
  textbox: (opts: Record<string, unknown>) => BlessedWidget;
  filemanager: (opts: Record<string, unknown>) => BlessedFileManager;
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

  // Transient banner for messages that land in a chat you're NOT reading.
  // Without it those arrivals were silent (only a badge in a list you may
  // not be looking at), so you'd miss someone writing to you.
  const toast = blessed.box({
    parent: screen,
    bottom: 4,
    right: 1,
    width: "40%",
    height: 3,
    border: { type: "line" },
    tags: true,
    hidden: true,
    style: { border: { fg: "yellow" }, bg: "black" },
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
  let tipShown = false;
  // Reset every time a chat opens, so the divider marks "since I started
  // reading this chat" rather than appearing once and never again.
  let newDividerShown = false;
  // jid → display name for the group currently open. Without this every
  // incoming group message rendered the GROUP's name as "who", not the
  // actual person who sent it — you couldn't tell members apart at all.
  let memberNames = new Map<string, string>();

  const setStatus = (text: string) => {
    statusBar.setContent(` {cyan-fg}Wacon{/} · ${text} · {gray-fg}Ctrl+N/P chat · Ctrl+K buscar · Ctrl+O adjuntar · Ctrl+C salir{/}`);
    screen.render();
  };

  let toastTimer: NodeJS.Timeout | null = null;
  const showToast = (from: string, text: string) => {
    toast.setContent(`{yellow-fg}💬 ${from}{/}\n{gray-fg}${text.slice(0, 60)}{/}`);
    toast.show();
    screen.render();
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.hide();
      screen.render();
    }, 6000);
  };

  // The list panel is only ~32% of the screen width. A 20-char name column
  // (the old value) plus the mark and badge routinely overflowed a normal
  // 80-column terminal, so blessed wrapped each row onto two lines — that
  // was the actual source of the list "looking disorganized". 13 fits
  // comfortably with border+badge even on a narrow terminal.
  const NAME_COL_LIST = 13;
  const renderList = () => {
    chatList.setItems(
      filtered.map((r) => {
        const mark = target && r.jid === target.jid ? "{green-fg}›{/}" : " ";
        const name = r.name.slice(0, NAME_COL_LIST).padEnd(NAME_COL_LIST);
        const badge = r.unread > 0 ? ` {yellow-fg}(${r.unread}){/}` : "";
        return `${mark} ${name}${badge}`;
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
      byJid.set(c.jid, { jid: c.jid, name: friendlyName(c.jid, c.display_name), unread: 0, lastTs: c.last_message_ts ?? 0, preview: "" });
    }
    for (const p of inbox as { chat: string; name: string | null; unansweredCount: number; lastMessage: string | null; lastTimestamp: number }[]) {
      const prev = byJid.get(p.chat);
      byJid.set(p.chat, {
        jid: p.chat,
        name: friendlyName(p.chat, p.name ?? prev?.name),
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
  // person can group together with a blank line at every turn change — this
  // is what makes the log read like a real chat instead of a flat,
  // undifferentiated stream.
  let lastSpeaker: string | null = null;
  let lastDay: string | null = null;
  const dayLabel = (ts: number) => new Date(ts).toLocaleDateString("es-PE", { day: "2-digit", month: "short" });
  // Every "who" label is padded to this width so message bodies always start
  // at the same column — variable-width names were the "sangría" (ragged
  // indent) that made group chats hard to scan.
  const NAME_COL_CONVO = 10;
  // "#4321" instead of a bare number — the last 4 digits alone could be
  // misread as part of a real phone number, especially for @lid ids, which
  // aren't phone numbers at all. The "#" signals "not a name, just a tag".
  const senderFallback = (jid: string) => `#${jid.split("@")[0]?.slice(-4) ?? "?"}`;

  // In a busy group everyone in the same colour is still hard to follow, so
  // each participant gets a stable colour derived from their jid (same
  // person, same colour every session). Green is reserved for "yo".
  const MEMBER_COLORS = ["cyan", "magenta", "yellow", "blue", "red", "white"];
  const colorFor = (key: string): string => {
    let hash = 0;
    for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
    return MEMBER_COLORS[hash % MEMBER_COLORS.length]!;
  };

  const renderLine = (m: { from_me?: number; text: string | null; timestamp: number; message_type?: string; id?: string; sender_jid?: string | null }) => {
    const day = dayLabel(m.timestamp);
    if (day !== lastDay) {
      convo.log(`{gray-fg}── ${day} ──{/}`);
      lastDay = day;
      lastSpeaker = null;
    }
    const isGroup = target ? target.jid.endsWith("@g.us") : false;
    const rawName = m.from_me
      ? "yo"
      : isGroup && m.sender_jid
        ? (memberNames.get(m.sender_jid) ?? senderFallback(m.sender_jid))
        : target
          ? firstName(target.name)
          : "?";
    // Group turns by the actual person, not just "me vs. them" — in a group
    // with several senders, two different people back-to-back should still
    // get the blank-line break.
    if (rawName !== lastSpeaker) {
      if (lastSpeaker !== null) convo.log("");
      lastSpeaker = rawName;
    }
    // Colour by the actual person in groups (so members are told apart at a
    // glance); a 1:1 chat has only one counterpart, so plain cyan is enough.
    const color = m.from_me ? "green" : isGroup && m.sender_jid ? colorFor(m.sender_jid) : "cyan";
    const who = `{${color}-fg}{bold}${rawName.slice(0, NAME_COL_CONVO).padEnd(NAME_COL_CONVO)}{/}{/}`;
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
    newDividerShown = false;
    memberNames = new Map();
    if (t.jid.endsWith("@g.us")) {
      // minMessages:1 so even someone who has posted once resolves by name
      // instead of falling back to a jid fragment.
      try {
        const members = (await client.groupMembers(t.jid, 1)) as { sender_jid: string; display_name: string | null }[];
        for (const mem of members) if (mem.display_name) memberNames.set(mem.sender_jid, mem.display_name);
      } catch {
        // best-effort — worst case senders show a short jid fragment
      }
    }
    convo.setLabel(` ${t.name} `);
    convo.setContent("");
    const msgs = await client.readMessages(t.jid, 30);
    for (const m of msgs.slice().reverse()) renderLine(m);
    if (!tipShown) {
      const tip = nextTip(ULTRA_TIPS);
      if (tip) {
        convo.log(`{cyan-fg}💡{/} {gray-fg}${tip}{/}`);
        lastSpeaker = null;
        tipShown = true;
      }
    }
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
          events: { id: string; chat: string; chatName: string | null; text: string | null; at: string; type: string; from: string | null }[];
        };
        cursor = r.cursor;
        for (const e of r.events) {
          if (!running) break;
          if (activeJid !== null && e.chat === activeJid) {
            // One "nuevos" divider per batch of arrivals, so you can always
            // see where the conversation was when you last looked.
            if (!newDividerShown) {
              convo.log("{yellow-fg}── nuevos mensajes ──{/}");
              lastSpeaker = null;
              newDividerShown = true;
            }
            renderLine({ from_me: 0, text: e.text, timestamp: new Date(e.at).getTime(), message_type: e.type, id: e.id, sender_jid: e.from });
            convo.setScrollPerc(100);
            await client.markRead(activeJid, 5).catch(() => undefined);
            const row = rows.find((x) => x.jid === e.chat);
            if (row) row.lastTs = Date.now();
          } else {
            showToast(friendlyName(e.chat, e.chatName), e.text ?? "(archivo)");
            // Bump the sender to the top of the list (real recency, matching
            // how the list is sorted) with an unread badge.
            const row = rows.find((x) => x.jid === e.chat);
            if (row) {
              row.unread += 1;
              row.lastTs = Date.now();
              rows = [row, ...rows.filter((x) => x.jid !== row.jid)];
            } else {
              rows.unshift({ jid: e.chat, name: friendlyName(e.chat, e.chatName), unread: 1, lastTs: Date.now(), preview: e.text ?? "" });
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
  /**
   * Browse for a file instead of demanding a typed absolute path — the old
   * flow required knowing and retyping a full path, which nobody does. Starts
   * in the last folder used (most people send several files from the same
   * place), falls back to home. Ctrl+G still allows typing/pasting a path,
   * which is what you want for a path copied from the file explorer.
   */
  let lastBrowseDir = homedir();
  const pickFile = (): Promise<string | null> =>
    new Promise((resolve) => {
      const fm = blessed.filemanager({
        parent: screen,
        label: " Elegir archivo · Enter abre · Ctrl+G escribir ruta · Esc cancela ",
        top: "center",
        left: "center",
        width: "70%",
        height: "70%",
        border: { type: "line" },
        keys: true,
        vi: true,
        mouse: true,
        scrollbar: { ch: " ", style: { bg: "gray" } },
        cwd: lastBrowseDir,
        style: { selected: { bg: "green", fg: "black" }, border: { fg: "cyan" } },
      });
      // Only re-arm the input when the user cancels. When a file WAS picked a
      // caption prompt follows immediately, and that prompt re-arms the input
      // itself on close — arming it here too would hand focus back and forth
      // in the same tick and leave cursor artifacts.
      const close = (result: string | null) => {
        fm.destroy();
        if (result === null && target) armInput();
        screen.render();
        resolve(result);
      };
      fm.on("file", (file: unknown) => {
        const p = String(file);
        lastBrowseDir = dirname(p);
        close(p);
      });
      fm.key(["escape", "q"], () => close(null));
      // Escape hatch: a path copied from the OS file explorer is faster to
      // paste than to navigate to.
      fm.key(["C-g"], () => {
        fm.destroy();
        screen.render();
        void prompt("pega o escribe la ruta del archivo").then((p) => resolve(p ? unquotePath(p) : null));
      });
      fm.focus();
      fm.refresh();
      screen.render();
    });

  const attachFile = () => {
    if (!target) return;
    void pickFile().then(async (path) => {
      if (!path) return;
      const caption = await prompt("comentario (opcional, Enter para omitir)");
      const r = await client.sendFile(target!.jid, path, { clientName: "cli-ultra", caption: caption ?? undefined });
      if ("guidance" in r) convo.log(`{yellow-fg}✖ ${r.guidance}{/}`);
      else if (r.sent) renderLine({ from_me: 1, text: `[${r.kind}: ${r.fileName}]${caption ? ` ${caption}` : ""}`, timestamp: Date.now() });
      else convo.log(`{yellow-fg}✖ no enviado: ${r.reason ?? "bloqueado"}{/}`);
      convo.setScrollPerc(100);
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
    "{bold}Wacon ultra — WhatsApp en tu terminal{/}\n\n" +
    "{cyan-fg}Moverte entre chats{/}\n" +
    "  Ctrl+N/P  chat siguiente / anterior (funciona escribiendo)\n" +
    "  Ctrl+K    buscar y saltar a un chat (funciona escribiendo)\n" +
    "  Esc/Tab   ir a la lista · ↑↓ moverte · Enter abrir\n" +
    "  /         buscar un chat (solo desde la lista)\n\n" +
    "{cyan-fg}Dentro de una conversación{/}\n" +
    "  Enter     enviar el mensaje que escribiste\n" +
    "  Ctrl+O    adjuntar archivo (se abre un explorador)\n" +
    "  Ctrl+S    enviar un sticker\n" +
    "  Ctrl+F    buscar dentro de la conversación\n" +
    "  Enter     (sobre la conversación) abre la última foto/audio\n\n" +
    "  Ctrl+C    salir\n\n" +
    "  {gray-fg}(pulsa Esc o Enter para cerrar){/}";

  /** Modal helper — every overlay must restore input focus on close. */
  const showOverlay = (label: string, content: string, height: number) => {
    const box = blessed.box({
      parent: screen,
      label: ` ${label} `,
      top: "center",
      left: "center",
      width: "60%",
      height,
      border: { type: "line" },
      tags: true,
      content,
      scrollable: true,
      keys: true,
      style: { border: { fg: "cyan" } },
    });
    box.focus();
    box.key(["escape", "enter", "space", "q", "?", "f1"], () => {
      (box as unknown as { destroy: () => void }).destroy();
      // Without an open chat there is no input to return to — focus the list,
      // otherwise closing the overlay would leave the keyboard doing nothing.
      if (target) armInput();
      else chatList.focus();
      screen.render();
    });
    screen.render();
  };
  const showHelp = () => showOverlay("Ayuda", HELP, 24);
  screen.key(["?", "f1"], showHelp);

  const quit = () => {
    running = false;
    screen.destroy();
    process.exit(0);
  };
  // Ctrl+C only — a bare "q" would quit the whole app while simply browsing
  // the chat list, which is far too easy to hit by accident.
  screen.key(["C-c"], quit);

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

  // First run ever: teach the three things you cannot guess (how to open a
  // chat, how to switch, how to attach). Shown once and never again — a
  // returning user gets straight to their chats.
  const WELCOME_ID = "ultra-welcome";
  if (!hasSeen(WELCOME_ID)) {
    markSeen(WELCOME_ID);
    showOverlay(
      "Bienvenido a Wacon",
      "{bold}Esto es WhatsApp dentro de tu terminal.{/}\n\n" +
        "Tres cosas y ya sabes usarlo:\n\n" +
        "  {cyan-fg}1.{/} A la izquierda están tus chats, ordenados por\n" +
        "     el más reciente. Muévete con {bold}↑↓{/} y abre con {bold}Enter{/}.\n\n" +
        "  {cyan-fg}2.{/} Escribe abajo y pulsa {bold}Enter{/} para enviar.\n" +
        "     Para cambiar de chat sin dejar de escribir: {bold}Ctrl+N{/}\n" +
        "     (siguiente) y {bold}Ctrl+P{/} (anterior).\n\n" +
        "  {cyan-fg}3.{/} {bold}Ctrl+O{/} adjunta un archivo (se abre un explorador,\n" +
        "     no hace falta escribir rutas).\n\n" +
        "En cualquier momento, {bold}?{/} muestra todos los atajos\n" +
        "y {bold}Ctrl+C{/} sale.\n\n" +
        "  {gray-fg}(Enter para empezar){/}",
      22
    );
  }
  screen.render();

  await feed; // keep the process alive until quit()
}
