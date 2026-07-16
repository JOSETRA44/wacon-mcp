import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import QRCode from "qrcode";
import type { WaconApi } from "./api.js";
import { PROFILE_SECTIONS } from "../memory/profiles.js";

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function iso(ts: number | null): string | null {
  return ts === null ? null : new Date(ts).toISOString();
}

function formatMessages(rows: { timestamp: number; from_me: number; sender_jid: string | null; text: string | null; message_type: string; id: string }[]) {
  return rows
    .slice()
    .reverse()
    .map((m) => ({
      id: m.id,
      at: iso(m.timestamp),
      from: m.from_me ? "me" : (m.sender_jid ?? "unknown"),
      type: m.message_type,
      text: m.text,
    }));
}

/**
 * Builds the Wacon MCP server against any WaconApi implementation, so the
 * exact same tools are served over Streamable HTTP (in the daemon) and over
 * stdio (via the shim that proxies to the daemon).
 */
export function buildMcpServer(api: WaconApi, clientLabel = "mcp"): McpServer {
  const server = new McpServer({ name: "wacon", version: "0.1.0" });

  // ── session ──────────────────────────────────────────────

  server.registerTool(
    "whatsapp_status",
    {
      title: "WhatsApp connection status",
      description:
        "Check the WhatsApp session state (connected / waiting_qr / logged_out) and local database stats. Call this first if any other tool fails.",
      inputSchema: {},
    },
    async () => json(await api.status())
  );

  server.registerTool(
    "whatsapp_login",
    {
      title: "Log in to WhatsApp (QR)",
      description:
        "Get the current login QR code as an image. Show it to the user and tell them to scan it from WhatsApp on their phone (Settings > Linked Devices > Link a Device). If already connected, reports that instead. The QR rotates every ~30s, so call again if it expired.",
      inputSchema: {},
    },
    async () => {
      const { state, qr } = await api.qr();
      if (state === "connected") {
        return json({ state, message: "Already logged in. No QR needed." });
      }
      if (!qr) {
        return json({
          state,
          message:
            state === "logged_out"
              ? "Session was logged out. The daemon is restarting the connection — call whatsapp_login again in a few seconds."
              : "No QR available yet — the connection is starting. Call whatsapp_login again in a few seconds.",
        });
      }
      const png = await QRCode.toDataURL(qr, { width: 512, margin: 2 });
      return {
        content: [
          {
            type: "text" as const,
            text: "Scan this QR from WhatsApp on your phone: Settings > Linked Devices > Link a Device. It rotates every ~30 seconds.",
          },
          { type: "image" as const, data: png.split(",")[1]!, mimeType: "image/png" },
        ],
      };
    }
  );

  // ── reading ──────────────────────────────────────────────

  server.registerTool(
    "list_chats",
    {
      title: "List recent chats",
      description: "List recent WhatsApp chats ordered by last activity, with names, JIDs, unread counts and last-message time.",
      inputSchema: { limit: z.number().int().min(1).max(100).default(30).describe("Max chats to return") },
    },
    async ({ limit }) => {
      const chats = (await api.listChats(limit)) as { jid: string; display_name: string | null; is_group: number; unread_count: number; last_message_ts: number | null }[];
      return json(
        chats.map((c) => ({
          jid: c.jid,
          name: c.display_name,
          isGroup: !!c.is_group,
          unread: c.unread_count,
          lastMessageAt: iso(c.last_message_ts),
        }))
      );
    }
  );

  server.registerTool(
    "read_messages",
    {
      title: "Read messages from a chat",
      description:
        "Read recent messages from one chat (oldest first in the result). Accepts a JID (from list_chats/search_contacts) or a bare phone number. Use before_timestamp (ms) to page further back.",
      inputSchema: {
        chat: z.string().describe("Chat JID (e.g. 5215512345678@s.whatsapp.net, groupid@g.us) or phone number"),
        limit: z.number().int().min(1).max(200).default(30),
        before_timestamp: z.number().optional().describe("Only messages older than this Unix ms timestamp"),
      },
    },
    async ({ chat, limit, before_timestamp }) => json(formatMessages(await api.readMessages(chat, limit, before_timestamp)))
  );

  server.registerTool(
    "search_messages",
    {
      title: "Full-text search in message history",
      description: "Search the entire synced message history (or one chat) with full-text search. Great for recalling topics, commitments, or how something was discussed before.",
      inputSchema: {
        query: z.string().min(1).describe("Words to search for"),
        chat: z.string().optional().describe("Restrict to this chat JID or phone"),
        limit: z.number().int().min(1).max(100).default(20),
      },
    },
    async ({ query, chat, limit }) => {
      const rows = await api.searchMessages(query, chat, limit);
      return json(
        rows.map((m) => ({
          chat: m.chat_jid,
          at: iso(m.timestamp),
          from: m.from_me ? "me" : (m.sender_jid ?? "unknown"),
          snippet: m.snippet,
          text: m.text,
        }))
      );
    }
  );

  server.registerTool(
    "search_contacts",
    {
      title: "Find a contact or group",
      description: "Search contacts and chats by name or phone number fragment. Returns JIDs to use with other tools.",
      inputSchema: { query: z.string().min(1).describe("Name or number fragment") },
    },
    async ({ query }) => json(await api.searchContacts(query))
  );

  server.registerTool(
    "get_group_info",
    {
      title: "Group metadata",
      description: "Get a WhatsApp group's subject, description, and participants (with admin flags).",
      inputSchema: { group_jid: z.string().describe("Group JID ending in @g.us") },
    },
    async ({ group_jid }) => json(await api.groupInfo(group_jid))
  );

  // ── sending ──────────────────────────────────────────────

  server.registerTool(
    "send_message",
    {
      title: "Send a WhatsApp message as the user",
      description:
        "Send a text message impersonating the user. MANDATORY workflow before calling this: 1) get_contact_profile for this chat to learn tone/emojis/formality and the user's global persona, 2) read_messages to see the live context, 3) draft matching the user's voice for THIS relationship. After a meaningful exchange, record new insights with update_contact_profile. Sends are rate-limited and may be in dry-run mode (check the response).",
      inputSchema: {
        chat: z.string().describe("Chat JID or phone number"),
        text: z.string().min(1).max(4096).describe("Message text, written in the user's voice for this contact"),
      },
    },
    async ({ chat, text }) => json(await api.send(chat, text, clientLabel))
  );

  // ── memory ───────────────────────────────────────────────

  server.registerTool(
    "get_contact_profile",
    {
      title: "Contact style profile + user persona",
      description:
        "REQUIRED before send_message. Returns (a) the style profile for this contact: quantitative stats (top emojis, formality, laughter style, message length, recurring phrases) plus qualitative notes from previous agents (relationship dynamics, inside jokes, what to avoid), and (b) the user's global persona. If no profile exists yet it is generated on the fly from history.",
      inputSchema: { chat: z.string().describe("Chat JID or phone number") },
    },
    async ({ chat }) => json(await api.getProfile(chat))
  );

  server.registerTool(
    "update_contact_profile",
    {
      title: "Record an observation about a contact",
      description:
        "Append a qualitative observation to a contact's profile so future agents (and the user) benefit. Use after conversations when you learn something durable: relationship dynamics, a recurring topic, an inside joke, or something to avoid. Keep each observation short and factual.",
      inputSchema: {
        chat: z.string().describe("Chat JID or phone number"),
        section: z.enum(PROFILE_SECTIONS).describe("Profile section to append to"),
        observation: z.string().min(3).max(500).describe("One concise observation"),
      },
    },
    async ({ chat, section, observation }) => {
      await api.observe(chat, section, observation);
      return json({ saved: true, section });
    }
  );

  server.registerTool(
    "analyze_contact",
    {
      title: "Recompute style stats for a contact",
      description:
        "Re-run the deterministic style analysis over the user's outgoing messages in this chat (emojis, formality, laughter, phrase habits) and store it in the profile. Use when history has grown or the profile looks stale.",
      inputSchema: { chat: z.string().describe("Chat JID or phone number") },
    },
    async ({ chat }) => json(await api.analyzeContact(chat))
  );

  server.registerTool(
    "get_persona",
    {
      title: "The user's global voice",
      description: "Read the user's global writing persona (persona.md): overall style stats plus hand-written rules that apply to EVERY message sent on their behalf.",
      inputSchema: {},
    },
    async () => json(await api.getPersona())
  );

  server.registerTool(
    "wacon_init",
    {
      title: "Bulk-analyze all history",
      description:
        "One-time (or occasional) bulk pass: builds the user's global persona from all outgoing messages and creates style profiles for every 1:1 chat with enough history. Run after the first full history sync.",
      inputSchema: {
        min_messages: z.number().int().min(5).default(30).describe("Minimum total messages in a chat to analyze it"),
      },
    },
    async ({ min_messages }) => json(await api.initAll(min_messages))
  );

  // ── resources ────────────────────────────────────────────

  server.registerResource(
    "persona",
    "wacon://persona",
    { title: "User persona", description: "Global writing voice of the user", mimeType: "text/markdown" },
    async (uri) => {
      const persona = await api.getPersona();
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: persona ? JSON.stringify(persona.stats ?? {}, null, 2) + "\n\n" + persona.body : "No persona yet. Run wacon_init." }] };
    }
  );

  server.registerResource(
    "profile",
    new ResourceTemplate("wacon://profile/{chat}", { list: undefined }),
    { title: "Contact style profile", description: "Per-contact style memory", mimeType: "text/markdown" },
    async (uri, { chat }) => {
      const { profile } = await api.getProfile(String(chat));
      const text = profile
        ? JSON.stringify(profile.stats ?? {}, null, 2) + "\n\n" + profile.body
        : "No profile for this chat yet.";
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text }] };
    }
  );

  // ── prompt ───────────────────────────────────────────────

  server.registerPrompt(
    "reply_in_style",
    {
      title: "Reply to a chat in the user's voice",
      description: "Assembles contact profile + persona + recent messages and asks for a reply that authentically matches how the user talks to this person.",
      argsSchema: { chat: z.string().describe("Chat JID or phone"), instruction: z.string().optional().describe("Optional guidance, e.g. 'decline politely'") },
    },
    async ({ chat, instruction }) => {
      const [{ profile, persona }, messages] = await Promise.all([api.getProfile(chat), api.readMessages(chat, 25)]);
      const context = [
        "# Persona global del usuario",
        persona ? persona.body : "(sin persona — ejecuta wacon_init)",
        persona?.stats ? `Stats globales: ${JSON.stringify(persona.stats)}` : "",
        "\n# Perfil de este contacto",
        profile ? `${JSON.stringify(profile.stats ?? {}, null, 1)}\n${profile.body}` : "(sin perfil todavía)",
        "\n# Últimos mensajes (viejo → nuevo)",
        ...formatMessages(messages).map((m) => `[${m.at}] ${m.from === "me" ? "YO" : m.from}: ${m.text ?? `(${m.type})`}`),
        "\n# Tarea",
        `Redacta la respuesta que YO enviaría a este chat, imitando exactamente mi voz con esta persona (emojis, risa, formalidad, longitud). ${instruction ?? ""}`,
        "Devuelve SOLO el texto del mensaje. Si dudas del tono, sé breve y neutro. Luego envíalo con send_message y registra lo aprendido con update_contact_profile.",
      ].join("\n");
      return { messages: [{ role: "user" as const, content: { type: "text" as const, text: context } }] };
    }
  );

  return server;
}
