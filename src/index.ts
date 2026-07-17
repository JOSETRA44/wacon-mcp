import { Command } from "commander";
import qrcodeTerminal from "qrcode-terminal";
import pc from "picocolors";
import { DaemonClient } from "./daemon/client.js";
import { readDaemonInfo, clearDaemonInfo, pingDaemon } from "./daemon/lifecycle.js";
import { runStdioServer } from "./mcp/stdio.js";
import { PROFILE_SECTIONS, profilePath, type ProfileSection } from "./memory/profiles.js";
import { WACON_HOME, PERSONA_PATH, CONFIG_PATH, DAEMON_LOG_PATH, NOTEBOOKS_PATH } from "./core/paths.js";
import { FACT_CATEGORIES } from "./memory/facts.js";

const program = new Command();
const client = new DaemonClient();

function fmtTime(iso: string | null | number): string {
  if (iso === null) return "—";
  const d = new Date(iso);
  return d.toLocaleString();
}

function die(err: unknown): never {
  console.error(pc.red(`error: ${err instanceof Error ? err.message : String(err)}`));
  process.exit(1);
}

program
  .name("wacon")
  .description("WhatsApp AI CLI + MCP server — manage WhatsApp from the terminal and let AI agents do it in your voice")
  .version("0.1.0");

program
  .command("login")
  .description("Link WhatsApp by scanning a QR code from your phone")
  .action(async () => {
    try {
      let lastQr: string | null = null;
      console.log(pc.cyan("Starting Wacon daemon and requesting QR..."));
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        const { state, qr } = await client.qr();
        if (state === "connected") {
          console.log(pc.green("\n✔ Connected. Your WhatsApp session is linked and will persist."));
          console.log(pc.dim("History is syncing in the background. Run `wacon status` to watch it grow, then `wacon init`."));
          return;
        }
        if (qr && qr !== lastQr) {
          lastQr = qr;
          console.log(pc.bold("\nScan this QR in WhatsApp: Settings > Linked Devices > Link a Device\n"));
          qrcodeTerminal.generate(qr, { small: true });
          console.log(pc.dim("QR rotates every ~30s — a fresh one will be shown automatically."));
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
      die("Timed out waiting for login (3 min). Try again.");
    } catch (err) {
      die(err);
    }
  });

program
  .command("status")
  .description("Connection state and local database stats")
  .action(async () => {
    try {
      const s = await client.status();
      const stateColor = s.state === "connected" ? pc.green : s.state === "waiting_qr" ? pc.yellow : pc.red;
      console.log(`state:     ${stateColor(s.state)}`);
      console.log(`account:   ${s.selfJid ?? "—"}`);
      console.log(`presence:  ${s.presence === "available" ? pc.green("available") : pc.dim(`${s.presence} (sigilo)`)}`);
      console.log(`watches:   ${s.activeWatches} activas`);
      console.log(`chats:     ${s.stats.chats}`);
      console.log(`contacts:  ${s.stats.contacts}`);
      console.log(`messages:  ${s.stats.messages} (${s.stats.outgoing} sent by you)`);
      console.log(pc.dim(`home:      ${WACON_HOME}`));
    } catch (err) {
      die(err);
    }
  });

program
  .command("logout")
  .description("Unlink the WhatsApp session and delete local credentials")
  .action(async () => {
    try {
      await client.logout();
      console.log(pc.green("Logged out and local credentials removed."));
    } catch (err) {
      die(err);
    }
  });

program
  .command("chats")
  .description("List recent chats")
  .option("-n, --limit <n>", "max chats", "20")
  .action(async (opts: { limit: string }) => {
    try {
      const chats = (await client.listChats(Number(opts.limit))) as {
        jid: string;
        display_name: string | null;
        is_group: number;
        unread_count: number;
        last_message_ts: number | null;
      }[];
      for (const c of chats) {
        const name = c.display_name ?? pc.dim("(sin nombre)");
        const badge = c.is_group ? pc.magenta("[grupo]") : "";
        const unread = c.unread_count > 0 ? pc.yellow(` (${c.unread_count} sin leer)`) : "";
        console.log(`${pc.bold(name)} ${badge}${unread}`);
        console.log(pc.dim(`  ${c.jid} · ${c.last_message_ts ? fmtTime(c.last_message_ts) : "—"}`));
      }
    } catch (err) {
      die(err);
    }
  });

program
  .command("read <chat>")
  .description("Read recent messages from a chat (JID or phone number)")
  .option("-n, --limit <n>", "max messages", "20")
  .action(async (chat: string, opts: { limit: string }) => {
    try {
      const msgs = await client.readMessages(chat, Number(opts.limit));
      for (const m of msgs.slice().reverse()) {
        const who = m.from_me ? pc.green("yo") : pc.cyan(m.sender_jid?.split("@")[0] ?? "?");
        console.log(`${pc.dim(fmtTime(m.timestamp))} ${who}: ${m.text ?? pc.dim(`(${m.message_type})`)}`);
      }
    } catch (err) {
      die(err);
    }
  });

program
  .command("send <chat> <text...>")
  .description("Send a message (respects rate limit / dry-run / allowlist in config.json)")
  .action(async (chat: string, textParts: string[]) => {
    try {
      const result = await client.send(chat, textParts.join(" "), "cli");
      if (result.sent) console.log(pc.green(`✔ sent (id: ${result.messageId})`));
      else console.log(pc.yellow(`✖ not sent: ${result.reason}`));
    } catch (err) {
      die(err);
    }
  });

program
  .command("search <query...>")
  .description("Full-text search across message history")
  .option("-c, --chat <jid>", "restrict to one chat")
  .option("-n, --limit <n>", "max results", "20")
  .action(async (queryParts: string[], opts: { chat?: string; limit: string }) => {
    try {
      const rows = await client.searchMessages(queryParts.join(" "), opts.chat, Number(opts.limit));
      for (const m of rows) {
        const who = m.from_me ? pc.green("yo") : pc.cyan(m.sender_jid?.split("@")[0] ?? "?");
        console.log(`${pc.dim(fmtTime(m.timestamp))} ${pc.dim(m.chat_jid)} ${who}: ${m.snippet}`);
      }
      if (rows.length === 0) console.log(pc.dim("no matches"));
    } catch (err) {
      die(err);
    }
  });

program
  .command("contacts <query>")
  .description("Find contacts/groups by name or number")
  .action(async (query: string) => {
    try {
      const rows = (await client.searchContacts(query)) as { jid: string; name: string | null; notify_name: string | null; is_group: number }[];
      for (const c of rows) {
        console.log(`${pc.bold(c.name ?? c.notify_name ?? "(sin nombre)")} ${c.is_group ? pc.magenta("[grupo]") : ""} ${pc.dim(c.jid)}`);
      }
      if (rows.length === 0) console.log(pc.dim("no matches"));
    } catch (err) {
      die(err);
    }
  });

program
  .command("watch")
  .description("Live-watch incoming messages in the terminal (triaged by priority)")
  .option("-m, --minutes <n>", "how long to watch", "30")
  .option("-p, --min-priority <n>", "only show messages above this score (0-100)", "0")
  .option("-g, --groups", "include group chats", false)
  .option("-k, --keyword <words...>", "only messages containing these words")
  .action(async (opts: { minutes: string; minPriority: string; groups: boolean; keyword?: string[] }) => {
    try {
      const session = await client.startWatch(
        {
          includeGroups: opts.groups,
          minPriority: Number(opts.minPriority),
          keywords: opts.keyword ?? [],
        },
        Number(opts.minutes),
        "cli"
      );
      const until = new Date(session.expiresAt).toLocaleTimeString();
      console.log(pc.cyan(`Watching until ${until} (Ctrl+C to stop)...`));
      let cursor: number | undefined;
      while (Date.now() < session.expiresAt) {
        const result = await client.waitForMessages({ since: cursor, sessionId: session.id, timeoutSeconds: 60 });
        cursor = result.cursor;
        for (const e of result.events) {
          const tag = e.priority >= 60 ? pc.red(`[${e.priority}]`) : e.priority >= 40 ? pc.yellow(`[${e.priority}]`) : pc.dim(`[${e.priority}]`);
          console.log(`${pc.dim(fmtTime(e.at))} ${tag} ${pc.bold(e.chatName ?? e.chat)}: ${e.text ?? pc.dim(`(${e.type})`)}`);
          console.log(pc.dim(`     ${e.reasons.join(", ")}`));
        }
      }
      await client.stopWatch(session.id);
      console.log(pc.dim("watch ended"));
    } catch (err) {
      die(err);
    }
  });

program
  .command("digest")
  .description("Compact catch-up: what arrived per chat")
  .option("-m, --minutes <n>", "look back this many minutes", "60")
  .action(async (opts: { minutes: string }) => {
    try {
      const d = await client.digest(Number(opts.minutes));
      console.log(pc.bold(`${d.totalIncoming} mensajes entrantes desde ${fmtTime(d.since)}\n`));
      for (const c of d.chats) {
        console.log(`${pc.bold(c.name ?? c.chat)} ${c.isGroup ? pc.magenta("[grupo]") : ""} ${pc.yellow(`×${c.incoming}`)}`);
        if (c.preview) console.log(pc.dim(`  ${c.preview}`));
      }
      if (d.chats.length === 0) console.log(pc.dim("nada nuevo"));
    } catch (err) {
      die(err);
    }
  });

program
  .command("window")
  .description("Should I stay online, and for how long? (predicted from your history)")
  .option("-c, --chat <jid>", "predict for one chat only")
  .action(async (opts: { chat?: string }) => {
    try {
      const w = await client.suggestWatchWindow(opts.chat);
      const color = w.now.level === "busy" ? pc.green : w.now.level === "dead" ? pc.red : pc.yellow;
      console.log(`ahora:        ${color(w.now.level)} (~${w.now.expectedPerHour} msg/h)`);
      console.log(`recomendado:  ${w.recommendedMinutes > 0 ? pc.bold(`${w.recommendedMinutes} min`) : pc.red("no vigilar ahora")}`);
      console.log(`esperados:    ~${w.expectedMessagesInWindow} mensajes`);
      console.log(pc.dim(`\n${w.rationale}`));
      console.log(pc.dim(`\npróximas horas: ${w.forecast.map((f) => `${f.hour}h:${f.expectedPerHour}`).join("  ")}`));
    } catch (err) {
      die(err);
    }
  });

program
  .command("presence <mode>")
  .description("Appear online or stealth: available | unavailable")
  .action(async (mode: string) => {
    try {
      if (!["available", "unavailable"].includes(mode)) die("mode must be 'available' or 'unavailable'");
      const r = await client.setPresence(mode as "available" | "unavailable");
      console.log(pc.green(`presence: ${r.presence}`));
    } catch (err) {
      die(err);
    }
  });

program
  .command("init")
  .description("Analyze all synced history: build persona.md + per-contact style profiles")
  .option("--min <n>", "minimum messages per chat", "30")
  .action(async (opts: { min: string }) => {
    try {
      console.log(pc.cyan("Analyzing your message history (local, no LLM involved)..."));
      const result = await client.initAll(Number(opts.min));
      console.log(pc.green(`✔ persona.md built from ${result.personaMessages} outgoing messages`));
      console.log(pc.green(`✔ ${result.profilesCreated.length} contact profiles created/updated`));
      console.log(pc.bold(`\nNow edit your persona by hand — nobody knows your voice better than you:`));
      console.log(`  ${PERSONA_PATH}`);
      console.log(pc.dim(`Profiles live in ${WACON_HOME}\\profiles\\`));
    } catch (err) {
      die(err);
    }
  });

program
  .command("profile <chat>")
  .description("Show (and generate if missing) the style profile of a contact")
  .option("--note <text>", "append a qualitative observation")
  .option("--section <name>", `section for --note: ${PROFILE_SECTIONS.join(" | ")}`, "Notas de agentes")
  .action(async (chat: string, opts: { note?: string; section: string }) => {
    try {
      if (opts.note) {
        await client.observe(chat, opts.section as ProfileSection, opts.note);
        console.log(pc.green(`✔ noted under "${opts.section}"`));
        return;
      }
      const { profile } = await client.getProfile(chat);
      if (!profile) {
        console.log(pc.yellow("No profile and not enough history to generate one (need ≥5 outgoing messages)."));
        return;
      }
      console.log(pc.bold(profile.displayName ?? profile.jid));
      if (profile.stats) console.log(pc.dim(JSON.stringify(profile.stats, null, 2)));
      console.log(`\n${profile.body}`);
      console.log(pc.dim(`\nfile: ${profilePath(profile.jid)}`));
    } catch (err) {
      die(err);
    }
  });

program
  .command("persona")
  .description("Show your global voice profile (persona.md)")
  .action(async () => {
    try {
      const persona = await client.getPersona();
      if (!persona) {
        console.log(pc.yellow("No persona yet. Run `wacon init` after your history syncs."));
        return;
      }
      if (persona.stats) console.log(pc.dim(JSON.stringify(persona.stats, null, 2)));
      console.log(`\n${persona.body}`);
      console.log(pc.dim(`\nfile: ${PERSONA_PATH}`));
    } catch (err) {
      die(err);
    }
  });

program
  .command("doctor")
  .description("Diagnose Wacon: WhatsApp, DB, daemon, NotebookLM, disk")
  .action(async () => {
    try {
      const report = await client.doctor();
      for (const c of report.checks) {
        const icon = c.status === "ok" ? pc.green("✓") : c.status === "warn" ? pc.yellow("⚠") : pc.red("✗");
        console.log(`${icon} ${pc.bold(c.name)}: ${c.detail}`);
        if (c.fix) console.log(pc.dim(`    → ${c.fix}`));
      }
      console.log(report.healthy ? pc.green("\nTodo lo esencial funciona.") : pc.red("\nHay problemas que resolver."));
    } catch (err) {
      die(err);
    }
  });

program
  .command("facts <chat>")
  .description("Facts known about a contact (dimension 1 of memory)")
  .option("--add <fact>", "add/update a fact")
  .option("--category <cat>", `category for --add: ${FACT_CATEGORIES.join(" | ")}`, "contexto")
  .option("--forget <id>", "delete a fact by id")
  .action(async (chat: string, opts: { add?: string; category: string; forget?: string }) => {
    try {
      if (opts.forget) {
        const r = await client.forgetFact(chat, Number(opts.forget));
        console.log(r.removed ? pc.green("✔ hecho eliminado") : pc.yellow("no existía ese hecho"));
        return;
      }
      if (opts.add) {
        const r = await client.rememberFact(chat, opts.category, opts.add);
        console.log(pc.green(`✔ ${r.updated ? "actualizado" : "guardado"} en ${r.category} (id ${r.id})`));
        return;
      }
      const { facts, gaps } = await client.getFacts(chat);
      if (facts.length === 0) console.log(pc.dim("(sin hechos registrados)"));
      for (const f of facts) {
        const conf = f.confidence < 0.5 ? pc.dim(" (tentativo)") : "";
        console.log(`${pc.dim(`#${f.id}`)} ${pc.cyan(f.category)}: ${f.fact}${conf}`);
      }
      if (gaps.length > 0) console.log(pc.dim(`\nhuecos por descubrir: ${gaps.map((g) => g.prompt).join(", ")}`));
    } catch (err) {
      die(err);
    }
  });

program
  .command("tag <chat> <tag>")
  .description("Mark a chat as special (routes it to a playbook notebook)")
  .action(async (chat: string, tag: string) => {
    try {
      const r = await client.tagChat(chat, tag);
      console.log(pc.green(`✔ etiquetas: ${r.tags.join(", ")}`));
    } catch (err) {
      die(err);
    }
  });

program
  .command("untag <chat> <tag>")
  .description("Remove a special tag from a chat")
  .action(async (chat: string, tag: string) => {
    try {
      const r = await client.untagChat(chat, tag);
      console.log(r.removed ? pc.green(`✔ quitado. etiquetas: ${r.tags.join(", ") || "(ninguna)"}`) : pc.yellow("no tenía esa etiqueta"));
    } catch (err) {
      die(err);
    }
  });

program
  .command("special")
  .description("List chats tagged as special")
  .action(async () => {
    try {
      const chats = await client.listSpecialChats();
      if (chats.length === 0) {
        console.log(pc.dim("no hay chats especiales. Usa `wacon tag <chat> <tag>`"));
        return;
      }
      for (const c of chats) console.log(`${pc.bold(c.name ?? c.jid)} ${pc.magenta(c.tags.join(", "))} ${pc.dim(c.jid)}`);
    } catch (err) {
      die(err);
    }
  });

program
  .command("playbook <chat> <situation...>")
  .description("Consult the external playbook (NotebookLM) for a special chat")
  .action(async (chat: string, situationParts: string[]) => {
    try {
      console.log(pc.cyan("Consultando el playbook (puede tardar)..."));
      const r = await client.consultPlaybook(chat, situationParts.join(" "));
      if (!r.consulted) {
        console.log(pc.yellow(r.note ?? "no se consultó"));
        return;
      }
      if (r.degraded) {
        console.log(pc.yellow(`⚠ ${r.note}`));
        return;
      }
      console.log(pc.bold(`\nConsejo (${r.notebook}${r.fromCache ? ", caché" : ""}):\n`));
      console.log(r.advice);
      if (r.citations && r.citations.length > 0) console.log(pc.dim(`\n${r.citations.length} citas de las fuentes`));
    } catch (err) {
      die(err);
    }
  });

program
  .command("errors")
  .description("Review recent internal errors (media, transcription, external calls)")
  .option("--tail <n>", "how many to show", "20")
  .option("-c, --chat <jid>", "filter to one chat")
  .action(async (opts: { tail: string; chat?: string }) => {
    try {
      const rows = await client.errorLog(Number(opts.tail), opts.chat);
      if (rows.length === 0) {
        console.log(pc.green("sin errores registrados ✓"));
        return;
      }
      for (const e of rows) {
        console.log(`${pc.dim(fmtTime(e.ts))} ${pc.red(e.operation)}${e.chat_jid ? pc.dim(` ${e.chat_jid}`) : ""}: ${e.error}`);
      }
    } catch (err) {
      die(err);
    }
  });

program
  .command("calendar")
  .description("Show upcoming events the bot has scheduled")
  .option("-d, --days <n>", "look ahead this many days", "30")
  .option("--all", "include done/cancelled", false)
  .action(async (opts: { days: string; all: boolean }) => {
    try {
      const events = await client.listEvents({ withinDays: Number(opts.days), includeDone: opts.all });
      if (events.length === 0) {
        console.log(pc.dim("no hay eventos agendados"));
        return;
      }
      for (const e of events) {
        const when = fmtTime(e.start_ts);
        const status = e.status === "scheduled" ? "" : pc.dim(` [${e.status}]`);
        console.log(`${pc.cyan(`#${e.id}`)} ${pc.bold(e.title)}${status}`);
        console.log(pc.dim(`   ${when}${e.chat_jid ? ` · ${e.chat_jid}` : ""}${e.notes ? ` · ${e.notes}` : ""}`));
      }
    } catch (err) {
      die(err);
    }
  });

program
  .command("tasks")
  .description("Show pending tasks the bot is tracking")
  .option("--all", "include completed", false)
  .action(async (opts: { all: boolean }) => {
    try {
      const tasks = await client.listTasks(opts.all);
      if (tasks.length === 0) {
        console.log(pc.dim("no hay tareas"));
        return;
      }
      for (const t of tasks) {
        const box = t.done ? pc.green("[x]") : pc.yellow("[ ]");
        const due = t.due_ts ? pc.dim(` (vence ${fmtTime(t.due_ts)})`) : "";
        console.log(`${box} ${pc.cyan(`#${t.id}`)} ${t.title}${due}`);
      }
    } catch (err) {
      die(err);
    }
  });

program
  .command("mcp")
  .description("Run the MCP server over stdio (register this in your AI agent)")
  .action(async () => {
    try {
      await runStdioServer();
    } catch (err) {
      die(err);
    }
  });

const daemon = program.command("daemon").description("Manage the background daemon");
daemon
  .command("start")
  .description("Start the daemon (usually automatic)")
  .action(async () => {
    try {
      await client.status();
      const info = readDaemonInfo();
      console.log(pc.green(`daemon running (pid ${info?.pid}, port ${info?.port})`));
    } catch (err) {
      die(err);
    }
  });
daemon
  .command("stop")
  .description("Stop the daemon")
  .action(async () => {
    const info = readDaemonInfo();
    if (!info || !(await pingDaemon(info))) {
      clearDaemonInfo();
      console.log(pc.dim("daemon not running"));
      return;
    }
    try {
      process.kill(info.pid);
      clearDaemonInfo();
      // Wait until the port is actually released so an immediate restart
      // doesn't race into EADDRINUSE.
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline && (await pingDaemon(info, 500))) {
        await new Promise((r) => setTimeout(r, 250));
      }
      console.log(pc.green("daemon stopped"));
    } catch (err) {
      die(err);
    }
  });
daemon
  .command("log")
  .description("Show the daemon log path")
  .action(() => {
    console.log(DAEMON_LOG_PATH);
  });

program
  .command("config")
  .description("Show the config file path (dry-run, rate limit, allowlist)")
  .action(() => {
    console.log(CONFIG_PATH);
    console.log(pc.dim(`notebooks (playbook): ${NOTEBOOKS_PATH}`));
  });

program.parseAsync().catch(die);
