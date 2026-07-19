import { Command } from "commander";
import qrcodeTerminal from "qrcode-terminal";
import { configureOutput, emit, fail, isJsonMode, c as pc } from "./cli/output.js";
import { DaemonClient } from "./daemon/client.js";
import { readDaemonInfo, clearDaemonInfo, pingDaemon } from "./daemon/lifecycle.js";
import { runStdioServer } from "./mcp/stdio.js";
import { PROFILE_SECTIONS, profilePath, type ProfileSection } from "./memory/profiles.js";
import { WACON_HOME, PERSONA_PATH, CONFIG_PATH, DAEMON_LOG_PATH, NOTEBOOKS_PATH } from "./core/paths.js";
import { FACT_CATEGORIES } from "./memory/facts.js";
import { installSkills, defaultSkillsTarget } from "./core/skills-install.js";
import { runChat } from "./cli/chat.js";

const program = new Command();
const client = new DaemonClient();

function fmtTime(iso: string | null | number): string {
  if (iso === null) return "—";
  const d = new Date(iso);
  return d.toLocaleString();
}

const die = fail;

program
  .name("wacon")
  .description("WhatsApp AI CLI + MCP server — manage WhatsApp from the terminal and let AI agents do it in your voice")
  .version("0.1.0")
  // Agent-facing flags: --json gives machine-readable output with zero ANSI.
  .option("--json", "machine-readable output (for agents/scripts)", false)
  .option("--no-color", "disable colour output")
  .hook("preAction", (thisCommand) => {
    const opts = thisCommand.opts<{ json?: boolean; color?: boolean }>();
    configureOutput({ json: opts.json === true, noColor: opts.color === false });
  });

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
      if (isJsonMode()) {
        emit(s, () => undefined);
        return;
      }
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
      emit(chats, () => {
        for (const chat of chats) {
          const name = chat.display_name ?? pc.dim("(sin nombre)");
          const badge = chat.is_group ? pc.magenta("[grupo]") : "";
          const unread = chat.unread_count > 0 ? pc.yellow(` (${chat.unread_count} sin leer)`) : "";
          console.log(`${pc.bold(name)} ${badge}${unread}`);
          console.log(pc.dim(`  ${chat.jid} · ${chat.last_message_ts ? fmtTime(chat.last_message_ts) : "—"}`));
        }
      });
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
      emit(msgs.slice().reverse(), () => {
        for (const m of msgs.slice().reverse()) {
          const who = m.from_me ? pc.green("yo") : pc.cyan(m.sender_jid?.split("@")[0] ?? "?");
          console.log(`${pc.dim(fmtTime(m.timestamp))} ${who}: ${m.text ?? pc.dim(`(${m.message_type})`)}`);
        }
      });
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
      emit(rows, () => {
        for (const m of rows) {
          const who = m.from_me ? pc.green("yo") : pc.cyan(m.sender_jid?.split("@")[0] ?? "?");
          console.log(`${pc.dim(fmtTime(m.timestamp))} ${pc.dim(m.chat_jid)} ${who}: ${m.snippet}`);
        }
        if (rows.length === 0) console.log(pc.dim("no matches"));
      });
    } catch (err) {
      die(err);
    }
  });

program
  .command("resolve <query>")
  .description("Resolve a name/number/JID to the real chat(s) with messages (@lid-aware)")
  .action(async (query: string) => {
    try {
      const hits = await client.resolveContact(query);
      emit(hits, () => {
        if (hits.length === 0) {
          console.log(pc.dim("sin coincidencias con mensajes"));
          return;
        }
        for (const h of hits) {
          console.log(`${pc.bold(h.displayName ?? "(sin nombre)")} ${pc.cyan(h.jid)}`);
          console.log(pc.dim(`   ${h.total} msgs (${h.outgoing} tuyos) · vía ${h.via}`));
        }
      });
    } catch (err) {
      die(err);
    }
  });

program
  .command("targets")
  .description("Ranked worklist of chats worth analyzing (for building the knowledge base)")
  .option("-n, --limit <n>", "how many", "25")
  .action(async (opts: { limit: string }) => {
    try {
      const rows = await client.analysisTargets(Number(opts.limit));
      emit(rows, () => {
        for (const r of rows) {
          const tag = r.isGroup ? pc.magenta("[grupo]") : "";
          const facts = r.hasFacts ? pc.green("✓hechos") : pc.dim("sin hechos");
          console.log(`${pc.bold(r.displayName ?? "(sin nombre)")} ${tag} ${facts}`);
          console.log(pc.dim(`   ${r.jid} · ${r.total} msgs (${r.outgoing} tuyos)`));
        }
      });
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
  .command("init [chat]")
  .description("Auto-analyze history (style, facts, episodes, group actionables) — brute force, no LLM")
  .option("--all", "include groups too (default: 1:1 contacts only)", false)
  .option("--groups", "only group chats", false)
  .option("--courses", "only university course groups", false)
  .option("--min <n>", "minimum outgoing messages per chat", "10")
  .action(async (chat: string | undefined, opts: { all: boolean; groups: boolean; courses: boolean; min: string }) => {
    try {
      // Persona (global voice) first — cheap and always useful.
      await client.initAll(30).catch(() => undefined);

      // `init all` is a keyword, not a chat name.
      const wantsAll = opts.all || chat?.toLowerCase() === "all";
      const chatArg = chat && chat.toLowerCase() !== "all" ? chat : undefined;
      const mode = chatArg ? "chat" : opts.courses ? "courses" : opts.groups ? "groups" : wantsAll ? "all" : "contacts";
      const job = (await client.runBulkAnalysis({ mode, chat: chatArg, minOutgoing: Number(opts.min) })) as {
        total: number;
      };
      console.log(pc.cyan(`Analizando ${job.total} chats (modo: ${mode}, sin IA)...\n`));

      // Live progress bar — the daemon does the work; we just render its status.
      const bar = (done: number, total: number) => {
        const width = 24;
        const filled = total > 0 ? Math.round((done / total) * width) : 0;
        return `[${"■".repeat(filled)}${"□".repeat(width - filled)}] ${done}/${total}`;
      };
      for (;;) {
        const s = (await client.analysisStatus()) as {
          running: boolean; total: number; processed: number; currentChat: string | null;
          factsFound: number; episodesSummarized: number; suggestionsFound: number; profilesBuilt: number; error: string | null;
        } | null; // eslint-disable-line @typescript-eslint/no-unnecessary-type-assertion
        if (!s) break;
        const line = `${bar(s.processed, s.total)}  ${pc.dim((s.currentChat ?? "").slice(0, 22).padEnd(22))} ${pc.green(`${s.factsFound}h`)} ${pc.cyan(`${s.episodesSummarized}ep`)} ${pc.yellow(`${s.suggestionsFound}sug`)}`;
        process.stdout.write(`\r${line}   `);
        if (!s.running) {
          process.stdout.write("\n");
          if (s.error) console.log(pc.red(`error: ${s.error}`));
          console.log(pc.green(`\n✔ ${s.profilesBuilt} perfiles · ${s.factsFound} hechos (auto, baja confianza) · ${s.episodesSummarized} episodios · ${s.suggestionsFound} sugerencias`));
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      console.log(pc.dim(`\nRevisa: wacon facts <chat> · wacon suggested · persona: ${PERSONA_PATH}`));
    } catch (err) {
      die(err);
    }
  });

program
  .command("chat [contacto]")
  .description("WhatsApp interactivo en la terminal (para humanos, no para agentes)")
  .action(async (contacto: string | undefined) => {
    try {
      if (isJsonMode()) die("`wacon chat` es interactivo; los agentes deben usar el MCP o los comandos con --json");
      await runChat(client, contacto);
    } catch (err) {
      die(err);
    }
  });

program
  .command("inbox")
  .description("What still needs your reply, ranked by priority")
  .option("-n, --limit <n>", "how many", "20")
  .option("-g, --groups", "include groups", false)
  .action(async (opts: { limit: string; groups: boolean }) => {
    try {
      const rows = (await client.inbox(Number(opts.limit), opts.groups)) as {
        chat: string; name: string | null; isGroup: boolean; waitingHours: number; unansweredCount: number; lastMessage: string | null; priority: number; reasons: string[];
      }[];
      emit(rows, () => {
        if (rows.length === 0) {
          console.log(pc.green("✔ nada pendiente — estás al día"));
          return;
        }
        for (const r of rows) {
          const age = r.waitingHours < 24 ? `${Math.round(r.waitingHours)}h` : `${Math.round(r.waitingHours / 24)}d`;
          const tag = r.priority >= 60 ? pc.red(`[${r.priority}]`) : r.priority >= 40 ? pc.yellow(`[${r.priority}]`) : pc.dim(`[${r.priority}]`);
          console.log(`${tag} ${pc.bold(r.name ?? r.chat)} ${r.isGroup ? pc.magenta("[grupo]") : ""} ${pc.dim(`hace ${age}`)}`);
          if (r.lastMessage) console.log(pc.dim(`     "${r.lastMessage.slice(0, 80)}"`));
          console.log(pc.dim(`     ${r.reasons.join(" · ")}`));
        }
      });
    } catch (err) {
      die(err);
    }
  });

program
  .command("commitments")
  .description("Promises you made and may not have kept")
  .option("-d, --days <n>", "look back", "21")
  .action(async (opts: { days: string }) => {
    try {
      const rows = (await client.commitments(Number(opts.days))) as { chat: string; name: string | null; at: string; text: string; ageDays: number }[];
      emit(rows, () => {
        if (rows.length === 0) {
          console.log(pc.green("✔ sin compromisos abiertos detectados"));
          return;
        }
        for (const r of rows) {
          console.log(`${pc.yellow(`hace ${r.ageDays}d`)} ${pc.bold(r.name ?? r.chat)}`);
          console.log(pc.dim(`     "${r.text}"`));
        }
        console.log(pc.dim("\nverifica antes de actuar: puede que ya lo hayas cumplido por otro medio"));
      });
    } catch (err) {
      die(err);
    }
  });

program
  .command("brief")
  .description("Start-of-day briefing: pendientes, compromisos, novedades y agenda")
  .option("-m, --minutes <n>", "ventana de novedades", "720")
  .action(async (opts: { minutes: string }) => {
    try {
      const b = (await client.briefing(Number(opts.minutes))) as {
        now: { human: string };
        pendingReplies: { name: string | null; chat: string; priority: number; waitingHours: number }[];
        openCommitments: { name: string | null; text: string; ageDays: number }[];
        newSince: { totalIncoming: number };
        upcomingEvents: { title: string; start_ts: number }[];
        openTasks: { title: string }[];
      };
      if (isJsonMode()) {
        emit(b, () => undefined);
        return;
      }
      console.log(pc.bold(`\n${b.now.human}\n`));
      console.log(pc.cyan(`📥 Te faltan responder (${b.pendingReplies.length})`));
      for (const p of b.pendingReplies.slice(0, 6)) {
        const age = p.waitingHours < 24 ? `${Math.round(p.waitingHours)}h` : `${Math.round(p.waitingHours / 24)}d`;
        console.log(`   ${pc.bold(p.name ?? p.chat)} ${pc.dim(`· hace ${age}`)}`);
      }
      if (b.openCommitments.length > 0) {
        console.log(pc.cyan(`\n🤝 Quedaste en hacer`));
        for (const c of b.openCommitments) console.log(`   ${pc.bold(c.name ?? "")}: ${pc.dim(c.text.slice(0, 60))} ${pc.dim(`(${c.ageDays}d)`)}`);
      }
      console.log(pc.cyan(`\n📨 Nuevos: ${b.newSince.totalIncoming} mensajes`));
      if (b.upcomingEvents.length > 0) {
        console.log(pc.cyan(`\n📅 Próximo`));
        for (const e of b.upcomingEvents.slice(0, 5)) console.log(`   ${fmtTime(e.start_ts)} · ${e.title}`);
      }
      if (b.openTasks.length > 0) {
        console.log(pc.cyan(`\n✅ Tareas`));
        for (const t of b.openTasks.slice(0, 5)) console.log(`   ${t.title}`);
      }
      console.log();
    } catch (err) {
      die(err);
    }
  });

program
  .command("members <group>")
  .description("Group participants; --analyze builds a profile for each one")
  .option("--analyze", "build style profiles + facts per member", false)
  .option("--min <n>", "minimum messages", "20")
  .action(async (group: string, opts: { analyze: boolean; min: string }) => {
    try {
      if (opts.analyze) {
        console.log(pc.cyan("Analizando miembros (sin IA)..."));
        const r = (await client.analyzeGroupMembers(group, Number(opts.min))) as {
          groupName: string | null; members: { name: string | null; jid: string; messages: number; factsFound: number; styleSummary: string | null }[];
        };
        console.log(pc.bold(`\n${r.groupName ?? group} — ${r.members.length} perfiles construidos\n`));
        for (const m of r.members) {
          console.log(`${pc.bold(m.name ?? m.jid)} ${pc.dim(`${m.messages} msgs · ${m.factsFound} hechos`)}`);
          if (m.styleSummary) console.log(pc.dim(`   ${m.styleSummary.slice(0, 100)}`));
        }
        return;
      }
      const r = (await client.groupMembers(group, Number(opts.min))) as {
        groupName: string | null; members: { name: string | null; jid: string; messages: number; hasProfile: boolean }[];
      };
      console.log(pc.bold(`${r.groupName ?? group} — ${r.members.length} participantes\n`));
      for (const m of r.members) {
        console.log(`${pc.bold((m.name ?? m.jid).slice(0, 30).padEnd(30))} ${pc.dim(`${m.messages} msgs`)} ${m.hasProfile ? pc.green("✓perfil") : pc.dim("sin perfil")}`);
      }
      console.log(pc.dim("\nconstruir perfiles: wacon members <group> --analyze"));
    } catch (err) {
      die(err);
    }
  });

program
  .command("skills")
  .description("Install the bundled agent skills (all of them, one command)")
  .option("--force", "overwrite existing installs", false)
  .option("--target <dir>", "where to install")
  .action((opts: { force: boolean; target?: string }) => {
    const r = installSkills(opts.target ?? defaultSkillsTarget(), opts.force);
    if (r.installed.length > 0) console.log(pc.green(`✔ instaladas: ${r.installed.join(", ")}`));
    if (r.skipped.length > 0) console.log(pc.dim(`ya existían: ${r.skipped.join(", ")} (usa --force para sobrescribir)`));
    if (r.installed.length === 0 && r.skipped.length === 0) console.log(pc.yellow("no encontré skills incluidas"));
    console.log(pc.dim(`destino: ${r.target}`));
  });

program
  .command("stickers")
  .description("Sticker library (own + cat pack) and per-contact habits")
  .option("--sync", "rebuild the catalog", false)
  .option("-m, --mood <mood>", "filter by mood")
  .option("-c, --chat <chat>", "show affinity/habits for a contact")
  .action(async (opts: { sync: boolean; mood?: string; chat?: string }) => {
    try {
      if (opts.sync) {
        const r = await client.syncStickers();
        console.log(pc.green(`✔ pack: ${r.packImported} · propios indexados: ${r.ownIndexed} · hábitos: ${r.habits}`));
        return;
      }
      const r = (await client.listStickers({ mood: opts.mood, chat: opts.chat })) as {
        stickers: { id: string; origin: string; mood: string | null; uses: number; description: string | null }[];
        moods: string[];
        affinity?: { stickersPerMessage: number; advice: string };
        contactMoods?: { mood: string; count: number }[];
      };
      if (r.affinity) {
        console.log(pc.bold(`Afinidad con ${opts.chat}: ${(r.affinity.stickersPerMessage * 100).toFixed(0)}% de tus mensajes`));
        console.log(pc.dim(`  ${r.affinity.advice}`));
        if (r.contactMoods?.length) console.log(pc.dim(`  moods que usas aquí: ${r.contactMoods.slice(0, 5).map((m) => `${m.mood}(${m.count})`).join(", ")}\n`));
      }
      for (const s of r.stickers) {
        const tag = s.origin === "own" ? pc.green("[propio]") : pc.magenta("[pack]");
        console.log(`${pc.cyan(s.id.padEnd(20))} ${tag} ${pc.yellow((s.mood ?? "—").padEnd(9))} ${pc.dim(s.description ?? "")}`);
      }
      if (r.stickers.length === 0) console.log(pc.dim("sin stickers — corre `wacon stickers --sync`"));
      else console.log(pc.dim(`\nmoods: ${r.moods.join(", ")}`));
    } catch (err) {
      die(err);
    }
  });

program
  .command("suggested")
  .description("Actionable events found in groups (review, then confirm)")
  .option("--confirm <id>", "promote a suggestion to a calendar event")
  .option("--dismiss <id>", "discard a suggestion")
  .action(async (opts: { confirm?: string; dismiss?: string }) => {
    try {
      if (opts.confirm) {
        const r = await client.confirmSuggestedEvent(Number(opts.confirm));
        console.log(r.confirmed ? pc.green(`✔ agendado como evento #${r.eventId}`) : pc.yellow("no encontrado"));
        return;
      }
      if (opts.dismiss) {
        await client.dismissSuggestedEvent(Number(opts.dismiss));
        console.log(pc.green("✔ descartado"));
        return;
      }
      const items = await client.listSuggestedEvents("suggested", 60);
      if (items.length === 0) {
        console.log(pc.dim("sin sugerencias (corre `wacon init --courses` o `--groups`)"));
        return;
      }
      for (const s of items) {
        console.log(`${pc.cyan(`#${s.id}`)} ${pc.bold(s.title)} ${s.when ? pc.yellow(fmtTime(s.when)) : pc.dim("(sin fecha)")}`);
        console.log(pc.dim(`   ${s.chatName ?? s.chat}`));
      }
      console.log(pc.dim("\nconfirmar: wacon suggested --confirm <id>"));
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
      emit(report, () => {
        for (const check of report.checks) {
          const icon = check.status === "ok" ? pc.green("✓") : check.status === "warn" ? pc.yellow("⚠") : pc.red("✗");
          console.log(`${icon} ${pc.bold(check.name)}: ${check.detail}`);
          if (check.fix) console.log(pc.dim(`    → ${check.fix}`));
        }
        console.log(report.healthy ? pc.green("\nTodo lo esencial funciona.") : pc.red("\nHay problemas que resolver."));
      });
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
