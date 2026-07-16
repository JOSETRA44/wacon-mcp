import { Command } from "commander";
import qrcodeTerminal from "qrcode-terminal";
import pc from "picocolors";
import { DaemonClient } from "./daemon/client.js";
import { readDaemonInfo, clearDaemonInfo, pingDaemon } from "./daemon/lifecycle.js";
import { runStdioServer } from "./mcp/stdio.js";
import { PROFILE_SECTIONS, profilePath, type ProfileSection } from "./memory/profiles.js";
import { WACON_HOME, PERSONA_PATH, CONFIG_PATH, DAEMON_LOG_PATH } from "./core/paths.js";

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
  });

program.parseAsync().catch(die);
