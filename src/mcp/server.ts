import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import QRCode from "qrcode";
import type { WaconApi } from "./api.js";
import { PROFILE_SECTIONS } from "../memory/profiles.js";
import { MAX_WATCH_MINUTES } from "../core/watch.js";

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
    "recall_context",
    {
      title: "Hybrid memory recall (RAG)",
      description:
        "The strongest retrieval tool: hybrid search over the whole history combining keyword match (BM25), semantic similarity (robust to typos/slang, e.g. 'q onda' matches 'que onda'), and recency — plus any agent-written episode summaries that match. Use this before replying to recover shared context: past plans, commitments, running topics, how something was left. Prefer this over search_messages unless you need exact keyword matching.",
      inputSchema: {
        query: z.string().min(2).describe("What you want to remember, in natural language (Spanish or English)"),
        chat: z.string().optional().describe("Restrict to this chat JID or phone (recommended when drafting a reply)"),
        limit: z.number().int().min(1).max(50).default(12),
      },
    },
    async ({ query, chat, limit }) => {
      const result = await api.recall(query, chat, limit);
      return json({
        messages: result.messages.map((h) => ({
          chat: h.message.chat_jid,
          at: iso(h.message.timestamp),
          from: h.message.from_me ? "me" : (h.message.sender_jid ?? "unknown"),
          text: h.message.text,
          matchedBy: h.matchedBy,
        })),
        episodeSummaries: result.episodes.map((e) => ({
          episodeId: e.id,
          chat: e.chat_jid,
          from: iso(e.start_ts),
          to: iso(e.end_ts),
          summary: e.summary,
        })),
      });
    }
  );

  server.registerTool(
    "list_episodes",
    {
      title: "List conversation episodes",
      description:
        "Segment a chat's history into conversation episodes (separated by >3h of silence) and list them, newest first, with agent-written summaries where they exist. Episodes without summary are opportunities: read them with read_episode and consolidate them with summarize_episode.",
      inputSchema: {
        chat: z.string().describe("Chat JID or phone number"),
        limit: z.number().int().min(1).max(100).default(20),
      },
    },
    async ({ chat, limit }) => {
      const episodes = (await api.listEpisodes(chat, limit)) as { id: number; start_ts: number; end_ts: number; message_count: number; summary: string | null }[];
      return json(
        episodes.map((e) => ({
          episodeId: e.id,
          from: iso(e.start_ts),
          to: iso(e.end_ts),
          messages: e.message_count,
          summary: e.summary ?? "(sin resumen — léelo con read_episode y consolídalo con summarize_episode)",
        }))
      );
    }
  );

  server.registerTool(
    "read_episode",
    {
      title: "Read a full conversation episode",
      description: "Read all messages of one episode (by episodeId from list_episodes). Use before writing its summary.",
      inputSchema: { episode_id: z.number().int().describe("Episode id from list_episodes") },
    },
    async ({ episode_id }) => {
      const result = (await api.readEpisode(episode_id)) as { episode: unknown; messages: Parameters<typeof formatMessages>[0] };
      return json({ episode: result.episode, messages: formatMessages(result.messages) });
    }
  );

  server.registerTool(
    "summarize_episode",
    {
      title: "Consolidate an episode into long-term memory",
      description:
        "Store a concise summary of a conversation episode (what happened, decisions, emotional tone, open threads). Summaries are semantically indexed and surface in recall_context, so THIS is how conversations become durable memory. Write in third person, past tense, max ~3 sentences, in the user's language.",
      inputSchema: {
        episode_id: z.number().int(),
        summary: z.string().min(10).max(600).describe("Concise factual summary of the episode"),
      },
    },
    async ({ episode_id, summary }) => json(await api.summarizeEpisode(episode_id, summary))
  );

  server.registerTool(
    "resolve_contact",
    {
      title: "Resolve a name/number to the real chat",
      description:
        "IMPORTANT for analysis: WhatsApp stores 1:1 chats under a privacy '@lid', NOT the phone number, so passing a contact's number or a name may not directly hit their messages. This resolves a name, phone number, or JID to the chat JID(s) that ACTUALLY hold messages, with message counts. Use it when read_messages/get_contact_profile come back empty for someone you know exists, or before deep-analyzing a contact. Most memory/read tools already resolve internally, but this lets you confirm the exact JID.",
      inputSchema: { query: z.string().min(2).describe("A contact name, phone number, or JID") },
    },
    async ({ query }) => json(await api.resolveContact(query))
  );

  server.registerTool(
    "list_analysis_targets",
    {
      title: "Ranked worklist for building the knowledge base",
      description:
        "Returns the chats most worth analyzing (ranked by how much the user writes there), each with its resolved display name, message counts, whether it's a group, and whether facts already exist. Use this to plan deep analysis — start with high-outgoing 1:1 chats that have no facts yet. Groups are included; skip low-value ones (sales, games) and focus on people and relevant groups.",
      inputSchema: { limit: z.number().int().min(1).max(100).default(25) },
    },
    async ({ limit }) => json(await api.analysisTargets(limit))
  );

  server.registerTool(
    "run_bulk_analysis",
    {
      title: "Brute-force analyze many chats (no LLM, no tokens)",
      description:
        "Kick off the deterministic analysis pipeline over many chats at once — it builds style/dynamics profiles, segments episodes with extractive summaries, extracts CANDIDATE facts (low-confidence, flagged) from 1:1 chats, and collects actionable SUGGESTIONS (exams/deadlines) from groups. Returns immediately with the job state; poll analysis_status to watch progress. This is the heavy lifting so you don't read chats one by one — afterwards call get_analysis_bundle(chat) to enrich the pre-chewed results cheaply. scope.mode: 'all' | 'contacts' | 'groups' | 'courses' (university course groups only) | 'chat' (needs scope.chat).",
      inputSchema: {
        mode: z.enum(["all", "contacts", "groups", "courses", "chat"]).default("contacts"),
        chat: z.string().optional().describe("Required when mode='chat'"),
        min_outgoing: z.number().int().min(1).default(10).describe("Skip chats where the user wrote fewer than this"),
      },
    },
    async ({ mode, chat, min_outgoing }) => json(await api.runBulkAnalysis({ mode, chat, minOutgoing: min_outgoing }))
  );

  server.registerTool(
    "analysis_status",
    {
      title: "Progress of the bulk analysis job",
      description: "Live status of the last/current run_bulk_analysis job: processed/total chats, current chat, and counts of facts, episodes and suggestions found. Poll this to show progress.",
      inputSchema: {},
    },
    async () => json(await api.analysisStatus())
  );

  server.registerTool(
    "get_analysis_bundle",
    {
      title: "Pre-chewed analysis package for a chat",
      description:
        "Everything Tier-1 already extracted for a chat, so you ENRICH instead of reading raw history: style stats + summary, dynamics notes, confirmed facts, CANDIDATE facts (machine-guessed — confirm the good ones with remember_fact, ignore the rest), episodes with (often auto) summaries, and — for groups — actionable suggestions. The token-efficient starting point for deepening a contact's memory.",
      inputSchema: { chat: z.string().describe("Chat name, phone or JID (auto-resolved)") },
    },
    async ({ chat }) => json(await api.getAnalysisBundle(chat))
  );

  server.registerTool(
    "list_suggested_events",
    {
      title: "Actionable suggestions found in groups",
      description: "List deadline/exam/deliverable items the analyzer found in group chats (suggestions only — not on the calendar). Review them and promote the real ones with confirm_suggested_event.",
      inputSchema: { limit: z.number().int().min(1).max(100).default(50) },
    },
    async ({ limit }) => json(await api.listSuggestedEvents("suggested", limit))
  );

  server.registerTool(
    "confirm_suggested_event",
    {
      title: "Promote a suggestion to a real calendar event",
      description: "Turn a suggested actionable into a scheduled calendar event (so the proactive engine can remind about it). Confirm the date makes sense first — if the suggestion had no parseable date it defaults to tomorrow and you should adjust.",
      inputSchema: { id: z.number().int(), notify_before_minutes: z.number().int().min(0).max(4320).default(720) },
    },
    async ({ id, notify_before_minutes }) => json(await api.confirmSuggestedEvent(id, notify_before_minutes))
  );

  server.registerTool(
    "dismiss_suggested_event",
    {
      title: "Dismiss a suggestion",
      description: "Discard an actionable suggestion that isn't worth scheduling.",
      inputSchema: { id: z.number().int() },
    },
    async ({ id }) => json(await api.dismissSuggestedEvent(id))
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
        "Send a text message impersonating the user. MANDATORY workflow before calling this: 1) get_contact_profile for this chat to learn tone/emojis/formality and the user's global persona, 2) read_messages to see the live context, 3) recall_context if the reply touches anything from the past (plans, promises, running topics), 4) draft matching the user's voice for THIS relationship. Afterwards, record durable insights with update_contact_profile and consolidate finished conversations with summarize_episode. Sends are rate-limited and may be in dry-run mode (check the response).",
      inputSchema: {
        chat: z.string().describe("Chat JID or phone number"),
        text: z.string().min(1).max(4096).describe("Message text, written in the user's voice for this contact"),
        typing_ms: z
          .number()
          .int()
          .min(0)
          .max(15000)
          .default(0)
          .describe("Show 'escribiendo…' for this long before sending. Real people don't reply instantly with a paragraph — a value near (text length × 40ms) reads as human."),
      },
    },
    async ({ chat, text, typing_ms }) => json(await api.send(chat, text, clientLabel, typing_ms))
  );

  // ── attention control (token efficiency) ─────────────────

  server.registerTool(
    "wait_for_messages",
    {
      title: "Block until new messages arrive",
      description:
        "Wait efficiently for incoming messages instead of polling. The daemon blocks server-side and returns the moment a message arrives (or when the timeout expires) — one call replaces an entire poll loop and costs a fraction of the tokens. Returns each message already triaged with a priority score (0-100) and the reasons behind it. Pass the returned `cursor` as `since` on your next call to resume exactly where you left off without missing or repeating events. Combine with start_watch to only be woken for messages that actually matter.",
      inputSchema: {
        timeout_seconds: z.number().int().min(1).max(120).default(60).describe("How long to block. Max 120s; call again in a loop for longer vigils."),
        since: z.number().int().optional().describe("Cursor from a previous wait_for_messages/watch_status call. Omit to only get messages from now on."),
        session_id: z.string().optional().describe("Watch session id from start_watch — applies its filters to this wait."),
      },
    },
    async ({ timeout_seconds, since, session_id }) =>
      json(await api.waitForMessages({ timeoutSeconds: timeout_seconds, since, sessionId: session_id }))
  );

  server.registerTool(
    "start_watch",
    {
      title: "Register what deserves your attention",
      description:
        "Declare a filter so the daemon only wakes you (via wait_for_messages) for messages that matter, evaluating rules for free instead of spending your tokens on noise. Filter by chats, keywords, groups, and a minimum priority score. Priority is computed deterministically: direct chats and group messages that mention the user score high; frequent contacts, replies and questions add points. A watch expires on its own after duration_minutes (max 240) so a crashed agent can never leave the daemon busy forever. Use suggest_watch_window first to pick a sensible duration.",
      inputSchema: {
        duration_minutes: z.number().int().min(1).max(MAX_WATCH_MINUTES).default(30),
        chats: z.array(z.string()).default([]).describe("Only these chat JIDs. Empty = any chat."),
        exclude_chats: z.array(z.string()).default([]).describe("Never wake for these chats"),
        keywords: z.array(z.string()).default([]).describe("Only wake if the text contains one of these (accent/case-insensitive)"),
        include_groups: z.boolean().default(false).describe("Groups are noisy; off by default"),
        min_priority: z.number().int().min(0).max(100).default(0).describe("Wake only above this priority. 40+ ≈ direct chats only; 60+ ≈ important only."),
      },
    },
    async ({ duration_minutes, chats, exclude_chats, keywords, include_groups, min_priority }) =>
      json(
        await api.startWatch(
          { chats, excludeChats: exclude_chats, keywords, includeGroups: include_groups, minPriority: min_priority },
          duration_minutes,
          clientLabel
        )
      )
  );

  server.registerTool(
    "stop_watch",
    {
      title: "End a watch session",
      description: "Stop one watch session (or all of them if no id is given). Good hygiene when you finish a vigil early.",
      inputSchema: { session_id: z.string().optional().describe("Omit to stop every active watch") },
    },
    async ({ session_id }) => json(await api.stopWatch(session_id))
  );

  server.registerTool(
    "watch_status",
    {
      title: "Active watches and current cursor",
      description: "List active watch sessions with their filters and minutes left, plus the current event cursor. Use the cursor as `since` in wait_for_messages to catch anything that arrives from this instant on.",
      inputSchema: {},
    },
    async () => json(await api.watchStatus())
  );

  server.registerTool(
    "suggest_watch_window",
    {
      title: "How long is it worth staying online?",
      description:
        "Answers 'should I wait here, and for how long?' from real history instead of guessing. Models message arrivals as a Poisson process using the last 8 weeks of this weekday+hour slot, and returns a recommended watch duration, the expected message count, a 12-hour forecast, and the next busy window. A recommendation of 0 minutes means the slot is dead and waiting would burn tokens for nothing — check back later instead. Call this before start_watch.",
      inputSchema: { chat: z.string().optional().describe("Predict for one chat only. Omit for all inbound traffic.") },
    },
    async ({ chat }) => json(await api.suggestWatchWindow(chat))
  );

  server.registerTool(
    "get_digest",
    {
      title: "Compact catch-up",
      description:
        "What arrived recently, grouped per chat: counts, last timestamp and a short preview — instead of dumping every message. Use this to catch up after being away (or at the start of a session) and then read in full only the chats worth it. Far cheaper than list_chats + read_messages across the board.",
      inputSchema: {
        since_minutes: z.number().int().min(1).max(10080).default(60).describe("Look back this many minutes (max 1 week)"),
        limit: z.number().int().min(1).max(100).default(40),
      },
    },
    async ({ since_minutes, limit }) => json(await api.digest(since_minutes, limit))
  );

  server.registerTool(
    "set_presence",
    {
      title: "Go online or stealth",
      description:
        "Control whether the user appears online to their contacts. 'unavailable' is stealth mode (the default): Wacon keeps receiving everything while the account looks offline — nobody sees 'en línea' at 3am just because an agent woke up. Use 'available' when the user genuinely wants to appear present, e.g. before an active conversation. 'composing' shows 'escribiendo…' in a specific chat.",
      inputSchema: {
        presence: z.enum(["available", "unavailable", "composing", "recording", "paused"]),
        chat: z.string().optional().describe("Required for composing/recording/paused; those are per-chat"),
      },
    },
    async ({ presence, chat }) => json(await api.setPresence(presence, chat))
  );

  server.registerTool(
    "mark_read",
    {
      title: "Send blue ticks",
      description:
        "Explicitly mark a chat's recent incoming messages as read. Reading through Wacon does NOT mark anything as read by itself — that's deliberate, so an agent scanning chats doesn't tell everyone the user saw their message. Use this only when the user is genuinely handling that conversation.",
      inputSchema: {
        chat: z.string().describe("Chat JID or phone number"),
        limit: z.number().int().min(1).max(50).default(20),
      },
    },
    async ({ chat, limit }) => json(await api.markRead(chat, limit))
  );

  // ── memory ───────────────────────────────────────────────

  server.registerTool(
    "get_contact_profile",
    {
      title: "Contact profile: facts + dynamics + style + tags",
      description:
        "REQUIRED before send_message. Returns the full two-dimensional memory of this contact: (1) FACTS about the person (facts, grouped by category — who they are, likes, dates) plus factGaps (high-value things still unknown, worth learning or asking), (2) interaction DYNAMICS and writing STYLE (the profile: emojis, formality, tuteo/usted, recurring phrases, inside jokes, what to avoid), plus (3) the user's global persona and any special tags on this chat. If drafting a reply, prefer prepare_reply which bundles this with recent messages and (for tagged chats) playbook advice.",
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

  // ── facts (memory dimension 1) ───────────────────────────

  server.registerTool(
    "remember_fact",
    {
      title: "Store a fact about the person",
      description:
        "Record a concrete fact ABOUT the contact (not about how you talk to them — that's update_contact_profile). Use whenever they reveal something durable: their job, birthday, a pet's name, a strong like/dislike, a goal. Facts are deduped and updated in place, so re-recording a changed fact overwrites the old one (this is how the person-profile stays current). Keep each fact atomic and short.",
      inputSchema: {
        chat: z.string().describe("Chat JID or phone number"),
        category: z.enum(["identidad", "ocupacion", "relacion", "fechas", "gustos", "disgustos", "contexto", "salud", "objetivos"]),
        fact: z.string().min(2).max(300).describe("One atomic fact, e.g. 'cumpleaños: 5 de marzo' or 'trabaja de enfermera'"),
        confidence: z.number().min(0).max(1).default(0.8).describe("How sure you are (below 0.5 is flagged as tentative)"),
      },
    },
    async ({ chat, category, fact, confidence }) => json(await api.rememberFact(chat, category, fact, confidence))
  );

  server.registerTool(
    "forget_fact",
    {
      title: "Delete a fact",
      description: "Remove a fact that turned out to be wrong or outdated (use the fact id from get_contact_facts / get_contact_profile).",
      inputSchema: { chat: z.string(), fact_id: z.number().int() },
    },
    async ({ chat, fact_id }) => json(await api.forgetFact(chat, fact_id))
  );

  server.registerTool(
    "get_contact_facts",
    {
      title: "Facts known about the person + gaps",
      description:
        "Return the structured facts known about this contact, grouped by category, plus 'gaps': high-value things still unknown (birthday, occupation, how you met…). Use the gaps to decide what to naturally learn or ask about next — that's how memory grows over time.",
      inputSchema: { chat: z.string().describe("Chat JID or phone number") },
    },
    async ({ chat }) => json(await api.getFacts(chat))
  );

  // ── special chats & external playbook ────────────────────

  server.registerTool(
    "tag_chat",
    {
      title: "Mark a chat as special",
      description:
        "Tag a chat (e.g. 'seduccion', 'ventas', 'debate', 'amistad') so it can draw on an external knowledge notebook via consult_playbook / prepare_reply. Tags map to NotebookLM notebooks in ~/.wacon/notebooks.json.",
      inputSchema: { chat: z.string(), tag: z.string().min(2).max(40).describe("A lowercase tag; see notebooks.json for mapped tags") },
    },
    async ({ chat, tag }) => json(await api.tagChat(chat, tag))
  );

  server.registerTool(
    "untag_chat",
    {
      title: "Remove a chat tag",
      description: "Remove a special tag from a chat.",
      inputSchema: { chat: z.string(), tag: z.string() },
    },
    async ({ chat, tag }) => json(await api.untagChat(chat, tag))
  );

  server.registerTool(
    "list_special_chats",
    {
      title: "List tagged chats",
      description: "List every chat that has special tags, with those tags.",
      inputSchema: {},
    },
    async () => json(await api.listSpecialChats())
  );

  server.registerTool(
    "consult_playbook",
    {
      title: "Ask the external playbook for advice",
      description:
        "For a chat tagged special (ventas, seducción, debate…), consult the mapped NotebookLM notebook (e.g. persuasion books) for concrete, sourced advice tailored to the situation and to what's known about the contact. Returns advice + citations. Degrades gracefully: if the notebook is unavailable, you'll get a note telling you to proceed with general knowledge — the reply flow never breaks. Wacon shows 'composing' while it thinks (this can take 10-30s, which is intentional and human-like). Only call for tagged chats; untagged chats have no playbook.",
      inputSchema: {
        chat: z.string(),
        situation: z.string().min(3).max(500).describe("What you're trying to achieve or the state of the conversation"),
      },
    },
    async ({ chat, situation }) => json(await api.consultPlaybook(chat, situation))
  );

  // ── prepare_reply: the reasoning-before-sending centerpiece ──

  server.registerTool(
    "prepare_reply",
    {
      title: "Assemble everything needed to reply authentically",
      description:
        "THE tool to call before replying. In one shot it bundles the full reasoning context so you don't make 5 separate calls: the user's global persona, the contact's FACTS (dim 1) and gaps, the interaction DYNAMICS + writing STYLE (dim 2), the last messages, relevant memory recall for the situation, and — only if the chat is tagged special — external playbook advice with citations. Sets 'composing' while it works. After it returns, write the reply in the user's voice, send with send_message, then persist what you learned (remember_fact / update_contact_profile / summarize_episode). Untagged chats skip the external notebook entirely (saves tokens and latency).",
      inputSchema: {
        chat: z.string().describe("Chat JID or phone number"),
        situation: z.string().max(500).optional().describe("What you intend to say or achieve. Enables memory recall and (for tagged chats) the playbook. Omit for a plain context bundle."),
      },
    },
    async ({ chat, situation }) => json(await api.prepareReply(chat, situation))
  );

  // ── diagnostics ──────────────────────────────────────────

  server.registerTool(
    "wacon_doctor",
    {
      title: "Diagnose the Wacon environment",
      description:
        "Check that everything Wacon depends on is healthy: WhatsApp session, local database, daemon, NotebookLM (nlm CLI auth + mapped notebooks exist), and disk space. Returns each check with ok/warn/fail and a suggested fix. Run this when something isn't working, or before relying on the playbook for the first time.",
      inputSchema: {},
    },
    async () => json(await api.doctor())
  );

  // ── multimedia (vista/oído) ──────────────────────────────

  server.registerTool(
    "view_image",
    {
      title: "See an image from a chat",
      description:
        "Download an image (or video thumbnail) a contact sent and return it so you can SEE it with your own vision. read_messages shows a '[imagen] usa view_image(message_id)' placeholder for these. If a vision backend is configured, a text description is also attached. NEVER invent an image's content — if this returns guidance instead of an image (a failure), follow that guidance and do not describe the image to the chat.",
      inputSchema: {
        chat: z.string().describe("Chat JID or phone number"),
        message_id: z.string().describe("The message id of the image (from read_messages)"),
      },
    },
    async ({ chat, message_id }) => {
      const r = await api.viewImage(chat, message_id);
      if (!r.ok) return json(r); // anti-fraud: natural guidance, never a raw error
      const blocks: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [
        { type: "image", data: r.base64, mimeType: r.mimetype },
      ];
      if (r.description) blocks.unshift({ type: "text", text: `Descripción automática: ${r.description}` });
      return { content: blocks };
    }
  );

  server.registerTool(
    "transcribe_audio",
    {
      title: "Hear a voice note",
      description:
        "Process a voice note / audio a contact sent. read_messages shows a '[nota de voz] usa transcribe_audio(message_id)' placeholder. By default (no backend configured) it returns the audio as a native block for you to HEAR directly if you're multimodal; if a transcription backend is configured, it returns the text instead. NEVER guess what an audio says — if this returns guidance (a failure), follow it and do not fabricate a transcript.",
      inputSchema: {
        chat: z.string().describe("Chat JID or phone number"),
        message_id: z.string().describe("The message id of the voice note (from read_messages)"),
      },
    },
    async ({ chat, message_id }) => {
      const r = await api.transcribeAudio(chat, message_id);
      if (!r.ok) return json(r);
      if (r.mode === "transcript") return json({ transcript: r.text });
      return {
        content: [
          { type: "text" as const, text: r.note },
          { type: "audio" as const, data: r.base64, mimeType: r.mimetype },
        ],
      };
    }
  );

  server.registerTool(
    "get_error_log",
    {
      title: "Review recent internal errors",
      description:
        "Show recent internal Wacon errors (media downloads, transcription, external calls). These are logged instead of being surfaced raw to chats. Use this to understand why a media tool returned guidance, or to audit what's failing.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).default(30),
        chat: z.string().optional().describe("Filter to one chat"),
      },
    },
    async ({ limit, chat }) => json(await api.errorLog(limit, chat))
  );

  // ── productivity (getting on top of messages) ────────────

  server.registerTool(
    "get_inbox",
    {
      title: "What still needs the user's reply",
      description:
        "⭐ The productivity core: chats where the LAST message came from the other person, so the ball is in the user's court — ranked by priority (direct chats, questions asked, messages piling up, recency). Use this for 'qué me falta responder', 'ponme al día', 'ayúdame con mis mensajes', or to triage a backlog. Far better than list_chats for figuring out where to spend attention.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(20),
        include_groups: z.boolean().default(false).describe("Groups are noisy; off by default"),
      },
    },
    async ({ limit, include_groups }) => json(await api.inbox(limit, include_groups))
  );

  server.registerTool(
    "get_commitments",
    {
      title: "Promises the user made and may not have kept",
      description:
        "Finds messages where the user promised something ('te aviso', 'mañana te mando', 'yo te confirmo') and never wrote again in that chat afterwards — likely dropped balls. Great for 'qué quedé en hacer', 'a quién le quedé mal', or a weekly review. Verify before acting: a promise may have been fulfilled by phone or in person.",
      inputSchema: { since_days: z.number().int().min(1).max(120).default(21) },
    },
    async ({ since_days }) => json(await api.commitments(since_days))
  );

  server.registerTool(
    "get_briefing",
    {
      title: "Start-of-day briefing",
      description:
        "One call that answers 'ponme al día': current time, what needs replies (ranked), open commitments, what arrived recently per chat, upcoming calendar events and open tasks. Use this to open a session, for a morning check-in, or when the user asks how things stand.",
      inputSchema: { since_minutes: z.number().int().min(30).max(10080).default(720).describe("Window for 'what arrived' (default 12h)") },
    },
    async ({ since_minutes }) => json(await api.briefing(since_minutes))
  );

  // ── group member profiling ───────────────────────────────

  server.registerTool(
    "list_group_members",
    {
      title: "Who's in a group and how much they talk",
      description: "List a group's participants with their message counts and whether they already have a style profile. Each participant has a stable id, so they can be profiled individually. Cheap overview — use before analyze_group_members.",
      inputSchema: { group: z.string().describe("Group JID or name"), min_messages: z.number().int().min(1).default(5) },
    },
    async ({ group, min_messages }) => json(await api.groupMembers(group, min_messages))
  );

  server.registerTool(
    "analyze_group_members",
    {
      title: "Build a profile for each person in a group",
      description:
        "Mass ingestion: analyzes each participant's messages separately (they each have a stable id) and builds a per-PERSON style profile plus candidate facts they revealed about themselves. Turns one big group into many usable contact memories — so when that person writes privately, or you need to address them in the group, there's already context. Deterministic and free. Run it on groups that matter (family, course, work); skip sales/game groups.",
      inputSchema: {
        group: z.string().describe("Group JID or name"),
        min_messages: z.number().int().min(5).default(20).describe("Skip members who barely talk"),
      },
    },
    async ({ group, min_messages }) => json(await api.analyzeGroupMembers(group, min_messages))
  );

  // ── stickers ─────────────────────────────────────────────

  server.registerTool(
    "list_stickers",
    {
      title: "Available stickers + this contact's sticker habits",
      description:
        "List sendable stickers, optionally filtered by mood (risa, carino, saludo, ok, travieso, beso, sorpresa, disculpa, molesto, neutral). Two origins: 'own' = stickers the user really sent (most authentic — reuse these first) and 'pack' = bundled cat stickers. Pass `chat` to also get that contact's sticker AFFINITY (how often the user actually sends stickers there) and which moods they use with them — respect it: if the affinity is low, send text only.",
      inputSchema: {
        mood: z.enum(["risa", "carino", "saludo", "ok", "travieso", "beso", "sorpresa", "disculpa", "molesto", "neutral"]).optional(),
        chat: z.string().optional().describe("Get affinity/habits for this contact"),
        limit: z.number().int().min(1).max(50).default(20),
      },
    },
    async ({ mood, chat, limit }) => json(await api.listStickers({ mood, chat, limit }))
  );

  server.registerTool(
    "send_sticker",
    {
      title: "Send a sticker",
      description:
        "Send a sticker by its library id (from list_stickers). WHEN to use one: at the emotional beat of a conversation — closing a joke (risa), greeting (saludo), warmth (carino), acknowledging (ok), softening a no or an apology (disculpa). Check the contact's affinity first with list_stickers({chat}): mirror the user's real habit instead of sprinkling stickers. Never send one in a serious/logistical message unless the user's history shows they do. Respects the same guardrails as send_message (rate limit, dry-run, allowlist) and degrades with guidance on failure — if it fails, just continue in text.",
      inputSchema: {
        chat: z.string().describe("Chat JID or phone number"),
        sticker_id: z.string().describe("Sticker id from list_stickers (e.g. 'cats:risa')"),
      },
    },
    async ({ chat, sticker_id }) => json(await api.sendSticker(chat, sticker_id, clientLabel))
  );

  server.registerTool(
    "send_file",
    {
      title: "Send a file (image, audio, video, PDF, any document)",
      description:
        "Send a local file to a chat. The kind is inferred from the extension: images and videos preview inline, audio can be sent as a real voice note (set as_voice_note), and anything else (PDF, Word, Excel, zip, txt…) goes as a document card keeping its filename. Use it to share a report, a photo, a recording, or homework. Same guardrails as send_message (rate limit, dry-run, allowlist) and it degrades with guidance on failure — if it can't send, say so rather than pretending. The file must already exist on this machine; give an absolute path.",
      inputSchema: {
        chat: z.string().describe("Chat JID or phone number"),
        path: z.string().describe("Absolute path to the file on this machine"),
        caption: z.string().max(1024).optional().describe("Text shown with the image/video/document"),
        as_voice_note: z.boolean().default(false).describe("For audio: send as a voice note (waveform) instead of an audio file"),
      },
    },
    async ({ chat, path, caption, as_voice_note }) =>
      json(await api.sendFile(chat, path, { caption, asVoiceNote: as_voice_note, clientName: clientLabel }))
  );

  server.registerTool(
    "sync_stickers",
    {
      title: "Rebuild the sticker catalog",
      description: "Index the bundled packs and the stickers the user has sent (tagging each with the mood inferred from the text before it). Run once, or after a big history sync, so list_stickers has fresh options.",
      inputSchema: {},
    },
    async () => json(await api.syncStickers())
  );

  // ── time, calendar & tasks ───────────────────────────────

  server.registerTool(
    "schedule_event",
    {
      title: "Schedule a calendar event",
      description:
        "Create an event so Wacon becomes proactive about it. At notify time (default 60 min before start) the proactive engine wakes any listening agent via wait_for_triggers. Link it to a chat to enable a proactive message (e.g. 'confirmar cita'). Use ISO dates or anything Date can parse; you know the current time from prepare_reply/get_agenda.",
      inputSchema: {
        title: z.string().min(2).describe("What the event is"),
        start: z.string().describe("Start datetime (ISO 8601, e.g. 2026-07-18T17:00:00)"),
        chat: z.string().optional().describe("Link to a chat JID/phone to enable a proactive message"),
        notify_before_minutes: z.number().int().min(0).max(1440).default(60),
        end: z.string().optional(),
        notes: z.string().optional(),
      },
    },
    async ({ title, start, chat, notify_before_minutes, end, notes }) =>
      json(await api.scheduleEvent({ title, start, chat, notifyBeforeMinutes: notify_before_minutes, end, notes }))
  );

  server.registerTool(
    "list_events",
    {
      title: "List calendar events",
      description: "List upcoming (or all) calendar events.",
      inputSchema: { within_days: z.number().int().min(1).max(365).optional(), include_done: z.boolean().default(false) },
    },
    async ({ within_days, include_done }) => json(await api.listEvents({ withinDays: within_days, includeDone: include_done }))
  );

  server.registerTool(
    "cancel_event",
    { title: "Cancel an event", description: "Cancel a scheduled event by id.", inputSchema: { event_id: z.number().int() } },
    async ({ event_id }) => json(await api.cancelEvent(event_id))
  );

  server.registerTool(
    "complete_event",
    { title: "Mark an event done", description: "Mark an event as completed by id.", inputSchema: { event_id: z.number().int() } },
    async ({ event_id }) => json(await api.completeEvent(event_id))
  );

  server.registerTool(
    "add_task",
    {
      title: "Add a task",
      description: "Add a to-do for the user/agent. Optional due date and linked chat.",
      inputSchema: { title: z.string().min(2), due: z.string().optional(), chat: z.string().optional(), notes: z.string().optional() },
    },
    async ({ title, due, chat, notes }) => json(await api.addTask({ title, due, chat, notes }))
  );

  server.registerTool(
    "list_tasks",
    { title: "List tasks", description: "List pending (or all) tasks.", inputSchema: { include_done: z.boolean().default(false) } },
    async ({ include_done }) => json(await api.listTasks(include_done))
  );

  server.registerTool(
    "complete_task",
    { title: "Complete a task", description: "Mark a task done by id.", inputSchema: { task_id: z.number().int() } },
    async ({ task_id }) => json(await api.completeTask(task_id))
  );

  server.registerTool(
    "get_agenda",
    {
      title: "Current time + upcoming events & tasks",
      description:
        "Get the current date/time (so you can resolve 'next friday', 'tomorrow') plus upcoming events and pending tasks. Call this when you need temporal awareness or to plan.",
      inputSchema: { within_days: z.number().int().min(1).max(90).default(7) },
    },
    async ({ within_days }) => json(await api.getAgenda(within_days))
  );

  server.registerTool(
    "wait_for_triggers",
    {
      title: "Block until a message OR a scheduled event fires",
      description:
        "The proactive long-poll. Blocks server-side and returns when either a new message arrives OR a scheduled event's notify time arrives (e.g. 'Reunión con María' 60 min before). This is how Wacon takes initiative: run this in a loop; when a trigger returns, YOU decide whether to send a proactive message (e.g. 'Hola María, ¿sigue en pie lo de las 5?'). The daemon never sends on its own. Pass back msgCursor/triggerCursor as since to resume without missing or repeating.",
      inputSchema: {
        timeout_seconds: z.number().int().min(1).max(120).default(60),
        since_msg: z.number().int().optional(),
        since_trigger: z.number().int().optional(),
      },
    },
    async ({ timeout_seconds, since_msg, since_trigger }) =>
      json(await api.waitForTriggers({ timeoutSeconds: timeout_seconds, sinceMsg: since_msg, sinceTrigger: since_trigger }))
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
