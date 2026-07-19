import * as readline from "node:readline";
import type { DaemonClient } from "../daemon/client.js";
import { c } from "./output.js";

/**
 * `wacon chat` — WhatsApp in the terminal, for HUMANS.
 *
 * Deliberately a classic line-based chat client rather than a full-screen TUI:
 * messages flow into the normal scrollback, so the terminal's own scrolling,
 * searching and copy/paste keep working, it starts instantly, and it needs no
 * extra dependency. Incoming messages are printed above the input line while
 * you type.
 *
 * Agents should NOT drive this — it's interactive and blocks. They have the MCP
 * tools, or the regular commands with --json.
 */

interface ChatTarget {
  jid: string;
  name: string;
}

const time = (ts: number | string) =>
  new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

function line(text = ""): void {
  process.stdout.write(`${text}\n`);
}

/** Print above the prompt without mangling what the user is currently typing. */
function printAbovePrompt(rl: readline.Interface, text: string): void {
  readline.cursorTo(process.stdout, 0);
  readline.clearLine(process.stdout, 0);
  line(text);
  rl.prompt(true);
}

function renderMessage(m: { from_me?: number; sender_jid?: string | null; text: string | null; timestamp: number; message_type?: string }, selfLabel = "yo", otherLabel = "?"): string {
  const who = m.from_me ? c.green(selfLabel) : c.cyan(otherLabel);
  const body = m.text ?? c.dim(`(${m.message_type ?? "media"})`);
  return ` ${c.dim(time(m.timestamp))}  ${who}  ${body}`;
}

async function pickChat(client: DaemonClient, rl: readline.Interface): Promise<ChatTarget | null> {
  // Pending replies first — when you open WhatsApp you usually owe someone.
  const inbox = (await client.inbox(15, false)) as { chat: string; name: string | null; waitingHours: number; lastMessage: string | null }[];
  if (inbox.length === 0) {
    line(c.dim("No hay conversaciones pendientes. Usa: wacon chat <contacto>"));
    return null;
  }
  line(c.bold("\nConversaciones pendientes:\n"));
  inbox.forEach((r, i) => {
    const age = r.waitingHours < 24 ? `${Math.round(r.waitingHours)}h` : `${Math.round(r.waitingHours / 24)}d`;
    line(` ${c.yellow(String(i + 1).padStart(2))}  ${c.bold((r.name ?? r.chat).slice(0, 28).padEnd(28))} ${c.dim(age.padStart(4))}  ${c.dim((r.lastMessage ?? "").slice(0, 40))}`);
  });
  line();

  const answer = await new Promise<string>((resolve) => rl.question(c.dim("número (o enter para salir) > "), resolve));
  const idx = Number(answer.trim()) - 1;
  const chosen = inbox[idx];
  if (!chosen) return null;
  return { jid: chosen.chat, name: chosen.name ?? chosen.chat };
}

async function resolveTarget(client: DaemonClient, query: string): Promise<ChatTarget | null> {
  const hits = await client.resolveContact(query);
  if (hits.length === 0) return null;
  const best = hits[0]!;
  return { jid: best.jid, name: best.displayName ?? best.jid };
}

async function showHeader(client: DaemonClient, target: ChatTarget): Promise<void> {
  const [status, receipts] = await Promise.all([client.status(), client.readReceiptsMode().catch(() => "unknown" as const)]);
  const conn = status.state === "connected" ? c.green("conectado") : c.red(status.state);
  const ticks = receipts === "on" ? "vistos: on" : receipts === "off" ? "vistos: off" : "vistos: ?";
  line(`\n${c.dim("──")} ${c.bold(target.name)} ${c.dim("·")} ${conn} ${c.dim(`· ${ticks}`)} ${c.dim("─".repeat(Math.max(0, 40 - target.name.length)))}`);
}

async function loadHistory(client: DaemonClient, target: ChatTarget, limit = 25): Promise<void> {
  const msgs = await client.readMessages(target.jid, limit);
  for (const m of msgs.slice().reverse()) {
    line(renderMessage(m, "yo", target.name.split(" ")[0] ?? "él/ella"));
  }
  line();
}

const HELP = `
${c.bold("Comandos")}
  /chats            elegir otra conversación
  /switch <texto>   cambiar a un contacto por nombre/número
  /read [n]         cargar más historial (por defecto 25)
  /search <texto>   buscar en esta conversación
  /sticker <mood>   enviar un sticker (risa, carino, saludo, ok, disculpa...)
  /who              miembros (si es un grupo)
  /help             esta ayuda
  /quit             salir
`;

/** Run the interactive session. Resolves when the user quits. */
export async function runChat(client: DaemonClient, initialQuery?: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });

  let target: ChatTarget | null = initialQuery ? await resolveTarget(client, initialQuery) : await pickChat(client, rl);
  if (!target) {
    if (initialQuery) line(c.yellow(`No encontré ninguna conversación para "${initialQuery}".`));
    rl.close();
    return;
  }

  // Cursor for the live feed; start from "now" so we only show what arrives.
  let cursor = ((await client.watchStatus()) as { cursor: number }).cursor;
  let running = true;
  let typingSince = 0;

  await showHeader(client, target);
  await loadHistory(client, target);
  await client.markRead(target.jid).catch(() => undefined); // honours the account's receipt setting

  // Live feed: long-poll in the background and print above the prompt.
  const feed = (async () => {
    while (running) {
      try {
        const r = await client.waitForMessages({ since: cursor, timeoutSeconds: 50 });
        cursor = r.cursor;
        for (const e of r.events) {
          if (!running) break;
          if (e.chat !== target!.jid) continue; // other chats stay quiet
          printAbovePrompt(rl, renderMessage(
            { from_me: 0, text: e.text, timestamp: new Date(e.at).getTime(), message_type: e.type },
            "yo",
            target!.name.split(" ")[0] ?? "él/ella"
          ));
          await client.markRead(target!.jid, 5).catch(() => undefined);
        }
      } catch {
        if (running) await new Promise((r) => setTimeout(r, 2000)); // daemon hiccup: back off
      }
    }
  })();

  const setTyping = async (on: boolean) => {
    if (!target) return;
    await client.setPresence(on ? "composing" : "paused", target.jid).catch(() => undefined);
  };

  rl.prompt();

  // Show "escribiendo…" to the contact while the user actually types.
  process.stdin.on("keypress", () => {
    const now = Date.now();
    if (now - typingSince > 4000) {
      typingSince = now;
      void setTyping(true);
    }
  });

  await new Promise<void>((resolve) => {
    rl.on("line", (input) => {
      void (async () => {
        const text = input.trim();
        if (text.length === 0) {
          rl.prompt();
          return;
        }

        if (text.startsWith("/")) {
          const [cmd, ...rest] = text.slice(1).split(/\s+/);
          const arg = rest.join(" ");
          switch (cmd) {
            case "quit":
            case "exit":
              running = false;
              rl.close();
              resolve();
              return;
            case "help":
              line(HELP);
              break;
            case "chats": {
              const next = await pickChat(client, rl);
              if (next) {
                target = next;
                await showHeader(client, target);
                await loadHistory(client, target);
                await client.markRead(target.jid).catch(() => undefined);
              }
              break;
            }
            case "switch": {
              const next = arg ? await resolveTarget(client, arg) : null;
              if (!next) line(c.yellow(`No encontré "${arg}".`));
              else {
                target = next;
                await showHeader(client, target);
                await loadHistory(client, target);
                await client.markRead(target.jid).catch(() => undefined);
              }
              break;
            }
            case "read": {
              await loadHistory(client, target!, Number(arg) || 25);
              break;
            }
            case "search": {
              if (!arg) line(c.dim("uso: /search <texto>"));
              else {
                const hits = await client.searchMessages(arg, target!.jid, 10);
                if (hits.length === 0) line(c.dim("sin resultados"));
                for (const h of hits) line(` ${c.dim(time(h.timestamp))}  ${h.from_me ? c.green("yo") : c.cyan("ellos")}  ${h.snippet}`);
              }
              break;
            }
            case "sticker": {
              const listed = (await client.listStickers({ mood: arg || undefined, chat: target!.jid, limit: 1 })) as {
                stickers: { id: string }[];
              };
              const sticker = listed.stickers[0];
              if (!sticker) line(c.yellow(`Sin stickers para "${arg}". Prueba: risa, carino, saludo, ok, disculpa`));
              else {
                const r = await client.sendSticker(target!.jid, sticker.id, "cli");
                line("ok" in r && r.ok === false ? c.yellow(`✖ ${r.guidance}`) : c.dim(` ${time(Date.now())}  ${c.green("yo")}  [sticker ${sticker.id}]`));
              }
              break;
            }
            case "who": {
              if (!target!.jid.endsWith("@g.us")) line(c.dim("no es un grupo"));
              else {
                const r = (await client.groupMembers(target!.jid, 3)) as { members: { name: string | null; messages: number }[] };
                for (const m of r.members.slice(0, 20)) line(` ${c.bold((m.name ?? "?").slice(0, 28).padEnd(28))} ${c.dim(`${m.messages} msgs`)}`);
              }
              break;
            }
            default:
              line(c.dim(`comando desconocido: /${cmd} — /help para la lista`));
          }
          rl.prompt();
          return;
        }

        // Plain text → send it.
        await setTyping(false);
        const result = await client.send(target!.jid, text, "cli");
        if (result.sent) {
          printAbovePrompt(rl, ` ${c.dim(time(Date.now()))}  ${c.green("yo")}  ${text}`);
        } else {
          printAbovePrompt(rl, c.yellow(` ✖ no enviado: ${result.reason ?? "bloqueado por los guardrails"}`));
        }
      })().catch((err) => {
        printAbovePrompt(rl, c.red(` error: ${err instanceof Error ? err.message : String(err)}`));
      });
    });

    rl.on("close", () => {
      running = false;
      resolve();
    });
  });

  await setTyping(false);
  running = false;
  await Promise.race([feed, new Promise((r) => setTimeout(r, 100))]);
  line(c.dim("\nchat cerrado"));
}
