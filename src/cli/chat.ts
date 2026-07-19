import * as readline from "node:readline";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DaemonClient } from "../daemon/client.js";
import { WACON_HOME } from "../core/paths.js";
import { c } from "./output.js";

const LAST_CHAT_FILE = join(WACON_HOME, "last-chat.json");

/** Remember where you were, so reopening the client doesn't start from zero. */
function rememberChat(target: ChatTarget): void {
  try {
    writeFileSync(LAST_CHAT_FILE, JSON.stringify(target));
  } catch {
    // not worth bothering the user about
  }
}

function recallChat(): ChatTarget | null {
  try {
    return JSON.parse(readFileSync(LAST_CHAT_FILE, "utf8")) as ChatTarget;
  } catch {
    return null;
  }
}

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
  const last = recallChat();
  line(c.bold("\nConversaciones pendientes:\n"));
  inbox.forEach((r, i) => {
    const age = r.waitingHours < 24 ? `${Math.round(r.waitingHours)}h` : `${Math.round(r.waitingHours / 24)}d`;
    line(` ${c.yellow(String(i + 1).padStart(2))}  ${c.bold((r.name ?? r.chat).slice(0, 28).padEnd(28))} ${c.dim(age.padStart(4))}  ${c.dim((r.lastMessage ?? "").slice(0, 40))}`);
  });
  if (last) line(`\n  ${c.cyan("enter")}  ${c.dim(`continuar con ${last.name}`)}`);
  line();

  const prompt = last ? c.dim("número (enter = continuar, q = salir) > ") : c.dim("número (o enter para salir) > ");
  const answer = (await new Promise<string>((resolve) => rl.question(prompt, resolve))).trim();
  if (answer.toLowerCase() === "q") return null;
  // Empty answer resumes where you left off — the common case after a quick exit.
  if (answer === "" ) return last;
  const chosen = inbox[Number(answer) - 1];
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

/**
 * Chats that pinged you while you were elsewhere, numbered so you can jump with
 * a single `/2`. Keeps the most recent few — enough to act on, not a menu.
 */
const jumpSlots: ChatTarget[] = [];

function rememberElsewhere(name: string, jid: string): number {
  const existing = jumpSlots.findIndex((s) => s.jid === jid);
  if (existing >= 0) return existing + 1;
  jumpSlots.push({ jid, name });
  if (jumpSlots.length > 9) jumpSlots.shift();
  return jumpSlots.findIndex((s) => s.jid === jid) + 1;
}

const HELP = `
${c.bold("Comandos")}
  /1 … /9           saltar a un chat que te escribió (aparece el número al avisarte)
  /chats            elegir otra conversación
  /switch <texto>   cambiar a un contacto por nombre/número
  /send <archivo>   enviar imagen, audio, PDF… (--voz para nota de voz)
  /read [n]         cargar más historial (por defecto 25)
  /search <texto>   buscar en esta conversación
  /sticker <mood>   enviar un sticker (risa, carino, saludo, ok, disculpa...)
  /who              miembros (si es un grupo)
  /help             esta ayuda
  /quit             salir

${c.dim("Tab autocompleta comandos y nombres de contactos.")}
`;

/** Run the interactive session. Resolves when the user quits. */
export async function runChat(client: DaemonClient, initialQuery?: string): Promise<void> {
  const COMMANDS = ["/chats", "/switch ", "/send ", "/read ", "/search ", "/sticker ", "/who", "/help", "/quit"];
  // Names of recent chats, so Tab can complete "/switch nay" → "/switch Nayda…".
  let completions: string[] = [];
  client
    .inbox(25, true)
    .then((rows) => {
      completions = (rows as { name: string | null }[]).map((r) => r.name ?? "").filter(Boolean);
    })
    .catch(() => undefined);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "> ",
    completer: (line: string): [string[], string] => {
      if (!line.startsWith("/")) return [[], line];
      const switchMatch = line.match(/^\/switch\s+(.*)$/i);
      if (switchMatch) {
        const partial = switchMatch[1]!.toLowerCase();
        const hits = completions.filter((n) => n.toLowerCase().includes(partial)).map((n) => `/switch ${n}`);
        return [hits.length > 0 ? hits : [], line];
      }
      const hits = COMMANDS.filter((cmd) => cmd.startsWith(line));
      return [hits.length > 0 ? hits : COMMANDS, line];
    },
  });

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

  rememberChat(target);
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
          if (e.chat === target!.jid) {
            printAbovePrompt(rl, renderMessage(
              { from_me: 0, text: e.text, timestamp: new Date(e.at).getTime(), message_type: e.type },
              "yo",
              target!.name.split(" ")[0] ?? "él/ella"
            ));
            await client.markRead(target!.jid, 5).catch(() => undefined);
          } else {
            // Someone else wrote you. Silently dropping this was the worst bit
            // of friction — you'd never know. Show it and offer a one-key jump.
            const label = e.chatName ?? e.chat;
            const slot = rememberElsewhere(label, e.chat);
            printAbovePrompt(
              rl,
              `${c.magenta("💬")} ${c.bold(label)}: ${c.dim((e.text ?? "(media)").slice(0, 50))} ${c.dim(`· /${slot} para ir`)}`
            );
          }
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

          // /1../9 — jump to a chat that pinged you, without typing its name.
          if (/^[1-9]$/.test(cmd ?? "")) {
            const slot = jumpSlots[Number(cmd) - 1];
            if (!slot) line(c.dim("ese número no corresponde a ningún aviso todavía"));
            else {
              target = slot;
              rememberChat(target);
              await showHeader(client, target);
              await loadHistory(client, target);
              await client.markRead(target.jid).catch(() => undefined);
            }
            rl.prompt();
            return;
          }

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
                rememberChat(target);
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
                line("guidance" in r ? c.yellow(`✖ ${r.guidance}`) : c.dim(` ${time(Date.now())}  ${c.green("yo")}  [sticker ${sticker.id}]`));
              }
              break;
            }
            case "send": {
              if (!arg) {
                line(c.dim("uso: /send <ruta del archivo> [--voz] [texto opcional]"));
                break;
              }
              // Allow: /send C:\ruta\foto.jpg mira esto   |  /send audio.ogg --voz
              const asVoiceNote = /(^|\s)--voz(\s|$)/.test(arg);
              const cleaned = arg.replace(/(^|\s)--voz(\s|$)/, " ").trim();
              const quoted = cleaned.match(/^"([^"]+)"\s*(.*)$/);
              const filePath = quoted ? quoted[1]! : (cleaned.split(/\s+/)[0] ?? "");
              const caption = quoted ? quoted[2] : cleaned.slice(filePath.length).trim();
              line(c.dim(`enviando ${filePath}...`));
              const r = await client.sendFile(target!.jid, filePath, { caption: caption || undefined, asVoiceNote, clientName: "cli" });
              if ("guidance" in r) line(c.yellow(`✖ ${r.guidance}`));
              else if (r.sent) printAbovePrompt(rl, ` ${c.dim(time(Date.now()))}  ${c.green("yo")}  ${c.dim(`[${r.kind}: ${r.fileName}]`)}${caption ? ` ${caption}` : ""}`);
              else line(c.yellow(`✖ no enviado: ${r.reason ?? "bloqueado"}`));
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
