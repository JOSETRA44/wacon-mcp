import Database from "better-sqlite3";
import { DB_PATH, ensureDirs } from "./paths.js";
import { vectorize, toBlob } from "../memory/vectorizer.js";
import { VISIBLE_MESSAGE_SQL } from "./message-types.js";

export interface ChatRow {
  jid: string;
  name: string | null;
  is_group: number;
  unread_count: number;
  last_message_ts: number | null;
}

export interface ChatOverviewRow {
  jid: string;
  is_group: number;
  unread_count: number;
  last_message_ts: number | null;
  display_name: string | null;
  alt_jid: string | null;
  last_text: string | null;
  last_from_me: number | null;
  last_type: string | null;
  last_sender_name: string | null;
  /** 1 when the chat is archived on the phone. */
  archived?: number;
}

export interface ContactRow {
  jid: string;
  name: string | null;
  notify_name: string | null;
}

export interface MessageRow {
  id: string;
  chat_jid: string;
  sender_jid: string | null;
  from_me: number;
  timestamp: number;
  text: string | null;
  message_type: string;
  quoted_id: string | null;
}

export interface SentLogRow {
  id: number;
  chat_jid: string;
  text: string;
  client_name: string;
  timestamp: number;
  dry_run: number;
}

export interface FactRow {
  id: number;
  jid: string;
  category: string;
  fact: string;
  confidence: number;
  source_msg_id: string | null;
  learned_at: number;
  updated_at: number;
}

export interface PlaybookCacheRow {
  id: number;
  tag: string;
  situation_hash: string;
  question: string;
  answer: string;
  citations_json: string | null;
  created_at: number;
}

export interface MediaRow {
  chat_jid: string;
  msg_id: string;
  kind: string;
  mimetype: string | null;
  media_key: string | null;
  direct_path: string | null;
  url: string | null;
  file_length: number | null;
  seconds: number | null;
  is_ptt: number;
  caption: string | null;
  timestamp: number;
}

export interface ErrorRow {
  id: number;
  ts: number;
  operation: string;
  chat_jid: string | null;
  error: string;
  context_json: string | null;
  client: string | null;
}

export interface EventRow {
  id: number;
  chat_jid: string | null;
  title: string;
  start_ts: number;
  end_ts: number | null;
  notify_ts: number | null;
  status: string;
  created_by: string | null;
  notes: string | null;
  created_at: number;
}

export interface TaskRow {
  id: number;
  title: string;
  due_ts: number | null;
  done: number;
  chat_jid: string | null;
  notes: string | null;
  created_at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chats (
  jid TEXT PRIMARY KEY,
  name TEXT,
  is_group INTEGER NOT NULL DEFAULT 0,
  unread_count INTEGER NOT NULL DEFAULT 0,
  last_message_ts INTEGER
);

CREATE TABLE IF NOT EXISTS contacts (
  jid TEXT PRIMARY KEY,
  name TEXT,
  notify_name TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT NOT NULL,
  chat_jid TEXT NOT NULL,
  sender_jid TEXT,
  from_me INTEGER NOT NULL DEFAULT 0,
  timestamp INTEGER NOT NULL,
  text TEXT,
  message_type TEXT NOT NULL DEFAULT 'text',
  quoted_id TEXT,
  PRIMARY KEY (chat_jid, id)
);
CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages (chat_jid, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_messages_from_me ON messages (from_me, timestamp DESC);

-- Reactions live apart from messages on purpose: an emoji reaction is not
-- something the user WROTE, and mixing it into messages.text would leak into
-- style analysis. One row per (message, reactor); an empty emoji = removed.
CREATE TABLE IF NOT EXISTS reactions (
  chat_jid TEXT NOT NULL,
  target_id TEXT NOT NULL,
  sender_jid TEXT NOT NULL,
  from_me INTEGER NOT NULL DEFAULT 0,
  emoji TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  PRIMARY KEY (chat_jid, target_id, sender_jid)
);
CREATE INDEX IF NOT EXISTS idx_reactions_target ON reactions (chat_jid, target_id);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text,
  content='messages',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TABLE IF NOT EXISTS message_vectors (
  rowid INTEGER PRIMARY KEY,
  chat_jid TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  vec BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vectors_chat ON message_vectors (chat_jid);

CREATE TABLE IF NOT EXISTS episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_jid TEXT NOT NULL,
  start_ts INTEGER NOT NULL,
  end_ts INTEGER NOT NULL,
  message_count INTEGER NOT NULL,
  summary TEXT,
  summary_vec BLOB,
  UNIQUE (chat_jid, start_ts)
);
CREATE INDEX IF NOT EXISTS idx_episodes_chat ON episodes (chat_jid, start_ts DESC);

CREATE TABLE IF NOT EXISTS sent_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_jid TEXT NOT NULL,
  text TEXT NOT NULL,
  client_name TEXT NOT NULL DEFAULT 'unknown',
  timestamp INTEGER NOT NULL,
  dry_run INTEGER NOT NULL DEFAULT 0
);

-- Dimension 1 of contact memory: discrete FACTS about the person (who they
-- are, what they like, dates). Kept structured (not prose) so they can be
-- deduped, updated in place, and retrieved selectively — that is what keeps
-- per-contact memory cheap in tokens.
CREATE TABLE IF NOT EXISTS contact_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  jid TEXT NOT NULL,
  category TEXT NOT NULL,
  fact TEXT NOT NULL,
  fact_norm TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.8,
  source_msg_id TEXT,
  learned_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (jid, fact_norm)
);
CREATE INDEX IF NOT EXISTS idx_facts_jid ON contact_facts (jid, category);

-- Chats flagged "special" (ventas, seduccion, debate...). A tag routes the
-- chat to an external knowledge notebook when an agent asks for a playbook.
CREATE TABLE IF NOT EXISTS chat_tags (
  jid TEXT NOT NULL,
  tag TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (jid, tag)
);
CREATE INDEX IF NOT EXISTS idx_tags_tag ON chat_tags (tag);

-- Cache of NotebookLM answers so similar situations don't re-query (saves
-- both latency and the external round-trip).
CREATE TABLE IF NOT EXISTS playbook_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tag TEXT NOT NULL,
  situation_hash TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  citations_json TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (tag, situation_hash)
);

-- Downloadable stubs for media messages. We store just enough to re-download
-- via Baileys (downloadContentFromMessage) after a restart, not the bytes.
CREATE TABLE IF NOT EXISTS media (
  chat_jid TEXT NOT NULL,
  msg_id TEXT NOT NULL,
  kind TEXT NOT NULL,          -- image | audio | video | document | sticker
  mimetype TEXT,
  media_key TEXT,             -- base64
  direct_path TEXT,
  url TEXT,
  file_length INTEGER,
  seconds INTEGER,            -- audio/video duration
  is_ptt INTEGER NOT NULL DEFAULT 0,  -- voice note vs audio file
  caption TEXT,
  timestamp INTEGER NOT NULL,
  PRIMARY KEY (chat_jid, msg_id)
);

-- Domain error log (distinct from process-level daemon.log). Anti-fraud rule:
-- media/external failures are recorded here and NEVER surfaced raw to the chat.
CREATE TABLE IF NOT EXISTS error_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  operation TEXT NOT NULL,
  chat_jid TEXT,
  error TEXT NOT NULL,
  context_json TEXT,
  client TEXT
);
CREATE INDEX IF NOT EXISTS idx_errors_ts ON error_log (ts DESC);

-- Calendar events. notify_ts is when the proactive engine should wake an agent.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_jid TEXT,
  title TEXT NOT NULL,
  start_ts INTEGER NOT NULL,
  end_ts INTEGER,
  notify_ts INTEGER,
  status TEXT NOT NULL DEFAULT 'scheduled',  -- scheduled | fired | done | cancelled
  created_by TEXT,
  notes TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_notify ON events (status, notify_ts);
CREATE INDEX IF NOT EXISTS idx_events_start ON events (start_ts);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  due_ts INTEGER,
  done INTEGER NOT NULL DEFAULT 0,
  chat_jid TEXT,
  notes TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_done ON tasks (done, due_ts);

-- Sticker catalog. Two origins: 'own' = stickers the user actually sent
-- (indexed from history, the most authentic option) and 'pack' = bundled
-- openly-licensed packs. The mood column is what lets an agent pick one.
CREATE TABLE IF NOT EXISTS sticker_library (
  id TEXT PRIMARY KEY,          -- own:<chat>|<msgId>  or  cats:<mood>
  origin TEXT NOT NULL,         -- own | pack
  pack TEXT,
  mood TEXT,
  file_path TEXT,               -- for pack stickers (bundled webp)
  chat_jid TEXT,                -- for own stickers (where to re-download from)
  msg_id TEXT,
  uses INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  description TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stickers_mood ON sticker_library (mood, origin);

-- Which moods the user expresses with stickers per contact, learned from the
-- text right before each sticker they sent. Drives "would he even send one?".
CREATE TABLE IF NOT EXISTS sticker_habits (
  chat_jid TEXT NOT NULL,
  mood TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_jid, mood)
);

-- Actionable items the brute-force analyzer found in group chats (exams,
-- deadlines...). SUGGESTIONS only — promoted to a real calendar event on
-- confirmation, never auto-scheduled.
CREATE TABLE IF NOT EXISTS suggested_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_jid TEXT NOT NULL,
  title TEXT NOT NULL,
  when_ts INTEGER,
  raw_text TEXT,
  source_msg_id TEXT,
  status TEXT NOT NULL DEFAULT 'suggested',  -- suggested | confirmed | dismissed
  created_at INTEGER NOT NULL,
  UNIQUE (chat_jid, title)
);
CREATE INDEX IF NOT EXISTS idx_suggested_status ON suggested_events (status, when_ts);

-- WhatsApp privacy: 1:1 chats live under a @lid, not the phone number. This
-- maps between them so a contact named/numbered by an agent resolves to the
-- chat that actually holds the messages. Fed from message alt-keys, contacts,
-- and lid-mapping events.
CREATE TABLE IF NOT EXISTS jid_map (
  lid TEXT PRIMARY KEY,
  pn TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jidmap_pn ON jid_map (pn);

-- One-off repairs and other small facts the store must remember across runs.
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Online/last-seen state, as reported by WhatsApp. Cached because presence
-- only arrives while subscribed: after a restart the last known value is
-- better than nothing, as long as we always say HOW OLD it is.
CREATE TABLE IF NOT EXISTS presence (
  jid TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  last_seen INTEGER,
  updated_at INTEGER NOT NULL
);
`;

/**
 * WhatsApp Channels (@newsletter) are broadcast-only — you cannot reply to
 * them — and bot endpoints aren't relationships either. Excluding them keeps
 * the inbox and the contact analysis about actual people; otherwise a channel
 * with 600 unread "unanswered" messages buries the friend who's waiting.
 */
const CONVERSATIONAL_ONLY = `AND {col} NOT LIKE '%@newsletter' AND {col} NOT LIKE '%@bot' AND {col} NOT LIKE '%@broadcast'`;
const conversational = (col: string) => CONVERSATIONAL_ONLY.replaceAll("{col}", col);

export class Store {
  readonly db: Database.Database;

  constructor(dbPath: string = DB_PATH) {
    ensureDirs();
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(SCHEMA);
    // Repair rows written while upsertChat leaked its "-1 = unknown" sentinel
    // into the INSERT path; a negative counter broke every later +1.
    this.db.exec(`UPDATE chats SET unread_count = 0 WHERE unread_count < 0`);
    // Delivery state of our own messages (WhatsApp's ✓ / ✓✓ / blue). Added
    // later, so older databases get the column here.
    const cols = this.db.prepare(`PRAGMA table_info(messages)`).all() as { name: string }[];
    if (!cols.some((c) => c.name === "status")) this.db.exec(`ALTER TABLE messages ADD COLUMN status INTEGER`);
    // Archived on the phone (WhatsApp's "Archivados"), synced from app state.
    const chatCols = this.db.prepare(`PRAGMA table_info(chats)`).all() as { name: string }[];
    if (!chatCols.some((c) => c.name === "archived")) this.db.exec(`ALTER TABLE chats ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`);
  }

  close(): void {
    this.db.close();
  }

  // ── chats ────────────────────────────────────────────────

  upsertChat(chat: { jid: string; name?: string | null; isGroup?: boolean; unreadCount?: number; lastMessageTs?: number | null }): void {
    this.db
      .prepare(
        `INSERT INTO chats (jid, name, is_group, unread_count, last_message_ts)
         VALUES (@jid, @name, @isGroup, MAX(@unreadCount, 0), @lastMessageTs)
         ON CONFLICT(jid) DO UPDATE SET
           name = COALESCE(excluded.name, chats.name),
           is_group = MAX(chats.is_group, excluded.is_group),
           unread_count = COALESCE(NULLIF(excluded.unread_count, -1), chats.unread_count),
           last_message_ts = MAX(COALESCE(chats.last_message_ts, 0), COALESCE(excluded.last_message_ts, 0))`
      )
      .run({
        jid: chat.jid,
        name: chat.name ?? null,
        isGroup: chat.isGroup ? 1 : chat.jid.endsWith("@g.us") ? 1 : 0,
        unreadCount: chat.unreadCount ?? -1,
        lastMessageTs: chat.lastMessageTs ?? null,
      });
  }

  /**
   * Archive state, applied to both halves of an @lid/phone pair: the phone
   * names the chat by either, and the list folds them into one row.
   */
  setArchived(jid: string, archived: boolean): void {
    const alt = jid.endsWith("@lid") ? this.pnForLid(jid) : this.lidForPn(jid);
    const set = this.db.prepare(`UPDATE chats SET archived = ? WHERE jid = ?`);
    for (const j of [jid, ...(alt ? [alt] : [])]) set.run(archived ? 1 : 0, j);
    // A chat we have not seen yet still has to remember it.
    this.db.prepare(`INSERT OR IGNORE INTO chats (jid, name, is_group, unread_count, last_message_ts, archived) VALUES (?, NULL, ?, 0, NULL, ?)`).run(jid, jid.endsWith("@g.us") ? 1 : 0, archived ? 1 : 0);
  }

  archivedCount(): number {
    return (this.db.prepare(`SELECT COUNT(*) n FROM chats WHERE archived = 1`).get() as { n: number }).n;
  }

  /** Small facts the store keeps across runs (one-off repairs, sync flags). */
  getMeta(key: string): string | null {
    return (this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value: string } | undefined)?.value ?? null;
  }
  setMeta(key: string, value: string): void {
    this.db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`).run(key, value);
  }

  /**
   * Keep WhatsApp's own unread counter live. History sync only delivers a
   * snapshot, so without this the badge froze at whatever it was at link time.
   */
  bumpUnread(jid: string): void {
    this.db.prepare(`UPDATE chats SET unread_count = unread_count + 1 WHERE jid = ?`).run(jid);
  }

  /** Reading (or replying to) a chat clears its badge, same as on the phone. */
  clearUnread(jid: string): void {
    this.db.prepare(`UPDATE chats SET unread_count = 0 WHERE jid = ?`).run(jid);
  }

  listChats(limit = 30): (ChatRow & { display_name: string | null })[] {
    // A contact's name can live under either half of an @lid<->phone-number
    // pair (WhatsApp's own privacy-jid split, see jid_map) — without this
    // cross-reference, a chat stored under @lid shows blank/a bare number
    // even when the same person's name is saved under their phone-number jid.
    return this.db
      .prepare(
        `SELECT c.*, COALESCE(c.name, ct.name, ct.notify_name, ct2.name, ct2.notify_name) AS display_name
         FROM chats c
         LEFT JOIN contacts ct ON ct.jid = c.jid
         LEFT JOIN jid_map jm ON jm.lid = c.jid OR jm.pn = c.jid
         LEFT JOIN contacts ct2 ON ct2.jid = (CASE WHEN jm.lid = c.jid THEN jm.pn ELSE jm.lid END)
         -- WhatsApp's internal threads are not conversations a person opens.
         WHERE c.jid NOT IN ('status@broadcast') AND c.jid NOT LIKE '%@newsletter' AND c.jid NOT LIKE '%@broadcast'
         -- The jid_map join can match several rows per chat; without this a
         -- single chat appeared repeatedly and ate into the LIMIT.
         GROUP BY c.jid
         ORDER BY c.last_message_ts DESC NULLS LAST
         LIMIT ?`
      )
      .all(limit) as (ChatRow & { display_name: string | null })[];
  }

  /**
   * Everything a WhatsApp-style chat list row needs in one query: name,
   * unread badge, and the LAST message (text, who sent it, type) for the
   * preview line. `alt_jid` is the other half of an @lid<->phone pair, so the
   * client can fold the two halves of one person into a single row.
   */
  chatOverview(limit = 150): ChatOverviewRow[] {
    return this.db
      .prepare(
        `SELECT c.jid, c.is_group, c.unread_count, c.last_message_ts, c.archived,
                COALESCE(c.name, ct.name, ct.notify_name, ct2.name, ct2.notify_name) AS display_name,
                CASE WHEN jm.lid = c.jid THEN jm.pn WHEN jm.pn = c.jid THEN jm.lid END AS alt_jid,
                m.text AS last_text, m.from_me AS last_from_me, m.message_type AS last_type,
                COALESCE(cs.name, cs.notify_name) AS last_sender_name
         FROM (SELECT * FROM chats
               WHERE jid NOT IN ('status@broadcast') AND jid NOT LIKE '%@newsletter' AND jid NOT LIKE '%@broadcast'
               ORDER BY last_message_ts DESC NULLS LAST LIMIT ?) c
         LEFT JOIN contacts ct ON ct.jid = c.jid
         LEFT JOIN jid_map jm ON jm.lid = c.jid OR jm.pn = c.jid
         LEFT JOIN contacts ct2 ON ct2.jid = (CASE WHEN jm.lid = c.jid THEN jm.pn ELSE jm.lid END)
         LEFT JOIN messages m ON m.rowid = (
           SELECT rowid FROM messages WHERE chat_jid = c.jid AND ${VISIBLE_MESSAGE_SQL} ORDER BY timestamp DESC LIMIT 1)
         LEFT JOIN contacts cs ON cs.jid = m.sender_jid
         GROUP BY c.jid
         ORDER BY c.last_message_ts DESC NULLS LAST`
      )
      .all(limit) as ChatOverviewRow[];
  }

  // ── contacts ─────────────────────────────────────────────

  upsertContact(contact: { jid: string; name?: string | null; notifyName?: string | null }): void {
    this.db
      .prepare(
        `INSERT INTO contacts (jid, name, notify_name)
         VALUES (@jid, @name, @notifyName)
         ON CONFLICT(jid) DO UPDATE SET
           name = COALESCE(excluded.name, contacts.name),
           notify_name = COALESCE(excluded.notify_name, contacts.notify_name)`
      )
      .run({ jid: contact.jid, name: contact.name ?? null, notifyName: contact.notifyName ?? null });
  }

  searchContacts(query: string, limit = 20): (ContactRow & { is_group: number })[] {
    const like = `%${query.replace(/[%_]/g, "")}%`;
    return this.db
      .prepare(
        `SELECT ct.jid, ct.name, ct.notify_name, COALESCE(c.is_group, 0) AS is_group
         FROM contacts ct LEFT JOIN chats c ON c.jid = ct.jid
         WHERE ct.jid LIKE ? OR ct.name LIKE ? OR ct.notify_name LIKE ?
         UNION
         SELECT c.jid, c.name, NULL, c.is_group
         FROM chats c
         WHERE (c.jid LIKE ? OR c.name LIKE ?) AND c.jid NOT IN (SELECT jid FROM contacts)
         LIMIT ?`
      )
      .all(like, like, like, like, like, limit) as (ContactRow & { is_group: number })[];
  }

  resolveDisplayName(jid: string): string | null {
    const lookup = (j: string): string | null => {
      const row = this.db
        .prepare(
          `SELECT COALESCE(c.name, ct.name, ct.notify_name) AS display_name
           FROM (SELECT ? AS jid) x
           LEFT JOIN chats c ON c.jid = x.jid
           LEFT JOIN contacts ct ON ct.jid = x.jid`
        )
        .get(j) as { display_name: string | null } | undefined;
      return row?.display_name ?? null;
    };
    // Direct name, or — for a @lid chat with no name — the name saved under its
    // mapped phone number (and vice versa).
    const direct = lookup(jid);
    if (direct) return direct;
    const alt = jid.endsWith("@lid") ? this.pnForLid(jid) : this.lidForPn(jid);
    return alt ? lookup(alt) : null;
  }

  // ── messages ─────────────────────────────────────────────

  insertMessage(msg: MessageRow): void {
    const result = this.db
      .prepare(
        `INSERT INTO messages (id, chat_jid, sender_jid, from_me, timestamp, text, message_type, quoted_id)
         VALUES (@id, @chat_jid, @sender_jid, @from_me, @timestamp, @text, @message_type, @quoted_id)
         ON CONFLICT(chat_jid, id) DO NOTHING`
      )
      .run(msg);
    if (result.changes > 0 && msg.text && msg.text.length >= 4) {
      this.db
        .prepare(`INSERT OR REPLACE INTO message_vectors (rowid, chat_jid, timestamp, vec) VALUES (?, ?, ?, ?)`)
        .run(result.lastInsertRowid, msg.chat_jid, msg.timestamp, toBlob(vectorize(msg.text)));
    }
  }

  /**
   * Record how far one of our messages got: 1 pending, 2 server, 3 delivered,
   * 4 read, 5 played. Receipts arrive out of order, so it only moves forward.
   */
  updateMessageStatus(chatJid: string, id: string, status: number): void {
    const run = (jid: string) =>
      this.db.prepare(`UPDATE messages SET status = MAX(COALESCE(status, 0), ?) WHERE chat_jid = ? AND id = ?`).run(status, jid, id).changes;
    if (run(chatJid) > 0) return;
    // The receipt can name the other half of the @lid/phone pair.
    const alt = chatJid.endsWith("@lid") ? this.pnForLid(chatJid) : this.lidForPn(chatJid);
    if (alt) run(alt);
  }

  /** Current delivery state of some of our messages, for the ✓✓ in the chat view. */
  messageStatuses(ids: string[]): { id: string; status: number | null }[] {
    if (ids.length === 0) return [];
    return this.db
      .prepare(`SELECT id, MAX(status) AS status FROM messages WHERE id IN (SELECT value FROM json_each(?)) GROUP BY id`)
      .all(JSON.stringify(ids)) as { id: string; status: number | null }[];
  }

  insertMessages(msgs: MessageRow[]): void {
    const insert = this.db.transaction((rows: MessageRow[]) => {
      for (const row of rows) this.insertMessage(row);
    });
    insert(msgs);
  }

  /**
   * Record (or clear, with an empty emoji) one person's reaction. Older
   * events never overwrite newer ones — history sync arrives out of order.
   */
  upsertReaction(r: { chatJid: string; targetId: string; senderJid: string; fromMe: boolean; emoji: string; timestamp: number }): void {
    if (!r.emoji) {
      this.db
        .prepare(`DELETE FROM reactions WHERE chat_jid = ? AND target_id = ? AND sender_jid = ? AND timestamp <= ?`)
        .run(r.chatJid, r.targetId, r.senderJid, r.timestamp);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO reactions (chat_jid, target_id, sender_jid, from_me, emoji, timestamp)
         VALUES (@chatJid, @targetId, @senderJid, @fromMe, @emoji, @timestamp)
         ON CONFLICT(chat_jid, target_id, sender_jid) DO UPDATE SET
           emoji = excluded.emoji, from_me = excluded.from_me, timestamp = excluded.timestamp
         WHERE excluded.timestamp >= reactions.timestamp`
      )
      .run({ ...r, fromMe: r.fromMe ? 1 : 0 });
  }

  /** Reactions on the given messages, across the given chats (an @lid/phone pair). */
  reactionsFor(chatJids: string[], targetIds: string[]): { target_id: string; sender_jid: string; from_me: number; emoji: string }[] {
    if (chatJids.length === 0 || targetIds.length === 0) return [];
    return this.db
      .prepare(
        `SELECT target_id, sender_jid, from_me, emoji FROM reactions
         WHERE chat_jid IN (SELECT value FROM json_each(?)) AND target_id IN (SELECT value FROM json_each(?))`
      )
      .all(JSON.stringify(chatJids), JSON.stringify(targetIds)) as { target_id: string; sender_jid: string; from_me: number; emoji: string }[];
  }

  /**
   * Messages by id, preferring the given chats. Ids are per-chat in the
   * schema, but a quote can point into the other half of an @lid/phone pair,
   * so an id is looked up in the preferred chats first, then anywhere.
   */
  messagesByIds(ids: string[], preferChats: string[] = []): MessageRow[] {
    if (ids.length === 0) return [];
    const stmt = this.db.prepare(
      `SELECT id, chat_jid, sender_jid, from_me, timestamp, text, message_type, quoted_id
       FROM messages WHERE id = ?
       ORDER BY CASE WHEN chat_jid IN (SELECT value FROM json_each(?)) THEN 0 ELSE 1 END
       LIMIT 1`
    );
    const prefer = JSON.stringify(preferChats);
    return ids.flatMap((id) => {
      const row = stmt.get(id, prefer) as MessageRow | undefined;
      return row ? [row] : [];
    });
  }

  readMessages(chatJid: string, limit = 30, beforeTs?: number): MessageRow[] {
    if (beforeTs !== undefined) {
      return this.db
        .prepare(
          `SELECT id, chat_jid, sender_jid, from_me, timestamp, text, message_type, quoted_id, status
           FROM messages WHERE chat_jid = ? AND timestamp < ?
           ORDER BY timestamp DESC LIMIT ?`
        )
        .all(chatJid, beforeTs, limit) as MessageRow[];
    }
    return this.db
      .prepare(
        `SELECT id, chat_jid, sender_jid, from_me, timestamp, text, message_type, quoted_id, status
         FROM messages WHERE chat_jid = ?
         ORDER BY timestamp DESC LIMIT ?`
      )
      .all(chatJid, limit) as MessageRow[];
  }

  searchMessages(query: string, opts: { chatJid?: string; limit?: number } = {}): (MessageRow & { snippet: string })[] {
    const limit = opts.limit ?? 20;
    // FTS5 special characters break MATCH; quote each term.
    const ftsQuery = query
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => `"${t.replace(/"/g, "")}"`)
      .join(" ");
    if (!ftsQuery) return [];
    const chatFilter = opts.chatJid ? "AND m.chat_jid = @chatJid" : "";
    return this.db
      .prepare(
        `SELECT m.id, m.chat_jid, m.sender_jid, m.from_me, m.timestamp, m.text, m.message_type, m.quoted_id,
                snippet(messages_fts, 0, '>>', '<<', '…', 12) AS snippet
         FROM messages_fts f JOIN messages m ON m.rowid = f.rowid
         WHERE messages_fts MATCH @query ${chatFilter}
         ORDER BY m.timestamp DESC LIMIT @limit`
      )
      .all({ query: ftsQuery, chatJid: opts.chatJid, limit }) as (MessageRow & { snippet: string })[];
  }

  /**
   * Messages whose text contains any of `patterns` (URL fragments or file
   * extensions), newest first, across every chat unless `chatJids` narrows it.
   * LIKE, not FTS: the FTS tokenizer splits URLs into useless pieces.
   */
  findLinks(patterns: string[], opts: { chatJids?: string[]; sinceTs?: number; text?: string; limit?: number } = {}): MessageRow[] {
    if (patterns.length === 0) return [];
    const params: unknown[] = patterns.map((p) => `%${p.replace(/[%_]/g, "")}%`);
    let where = `(${patterns.map(() => "text LIKE ?").join(" OR ")})`;
    if (opts.chatJids?.length) {
      where += ` AND chat_jid IN (${opts.chatJids.map(() => "?").join(",")})`;
      params.push(...opts.chatJids);
    }
    if (opts.sinceTs) {
      where += " AND timestamp >= ?";
      params.push(opts.sinceTs);
    }
    if (opts.text?.trim()) {
      where += " AND text LIKE ?";
      params.push(`%${opts.text.trim().replace(/[%_]/g, "")}%`);
    }
    params.push(Math.min(200, opts.limit ?? 30));
    return this.db
      .prepare(
        `SELECT id, chat_jid, sender_jid, from_me, timestamp, text, message_type, quoted_id
         FROM messages WHERE ${where} AND chat_jid NOT LIKE '%@newsletter' AND chat_jid <> 'status@broadcast'
         ORDER BY timestamp DESC LIMIT ?`
      )
      .all(...params) as MessageRow[];
  }

  /** Messages sent by the user in one chat — the raw material for style analysis. */
  outgoingMessages(chatJid: string, limit = 500): MessageRow[] {
    return this.db
      .prepare(
        `SELECT id, chat_jid, sender_jid, from_me, timestamp, text, message_type, quoted_id
         FROM messages WHERE chat_jid = ? AND from_me = 1 AND text IS NOT NULL
         ORDER BY timestamp DESC LIMIT ?`
      )
      .all(chatJid, limit) as MessageRow[];
  }

  /**
   * Balanced sample of the user's outgoing messages for the GLOBAL persona:
   * caps how much any single chat contributes, so one very heavy chat (an AI
   * assistant, a work group) can't drown out how the user actually talks to
   * people. Groups are excluded — group voice differs from 1:1 voice.
   */
  balancedOutgoingSample(perChatCap = 120, excludeJids: string[] = []): MessageRow[] {
    const placeholders = excludeJids.length > 0 ? `AND chat_jid NOT IN (${excludeJids.map(() => "?").join(",")})` : "";
    return this.db
      .prepare(
        `SELECT id, chat_jid, sender_jid, from_me, timestamp, text, message_type, quoted_id FROM (
           SELECT *, ROW_NUMBER() OVER (PARTITION BY chat_jid ORDER BY timestamp DESC) rn
           FROM messages
           WHERE from_me = 1 AND text IS NOT NULL AND chat_jid NOT LIKE '%@g.us' ${placeholders}
         ) WHERE rn <= ?`
      )
      .all(...excludeJids, perChatCap) as MessageRow[];
  }

  /** All outgoing messages across chats — for the global persona analysis. */
  allOutgoingMessages(limit = 5000): MessageRow[] {
    return this.db
      .prepare(
        `SELECT id, chat_jid, sender_jid, from_me, timestamp, text, message_type, quoted_id
         FROM messages WHERE from_me = 1 AND text IS NOT NULL
         ORDER BY timestamp DESC LIMIT ?`
      )
      .all(limit) as MessageRow[];
  }

  chatsWithMessageCounts(minMessages = 20): { chat_jid: string; total: number; outgoing: number }[] {
    return this.db
      .prepare(
        `SELECT chat_jid, COUNT(*) AS total, SUM(from_me) AS outgoing
         FROM messages GROUP BY chat_jid
         HAVING COUNT(*) >= ? ORDER BY total DESC`
      )
      .all(minMessages) as { chat_jid: string; total: number; outgoing: number }[];
  }

  // ── vectors & episodes (hybrid memory) ───────────────────

  /** Index any messages missing from message_vectors. Idempotent; run at daemon start. */
  backfillVectors(): number {
    const missing = this.db
      .prepare(
        `SELECT m.rowid AS rowid, m.chat_jid, m.timestamp, m.text
         FROM messages m LEFT JOIN message_vectors v ON v.rowid = m.rowid
         WHERE v.rowid IS NULL AND m.text IS NOT NULL AND LENGTH(m.text) >= 4`
      )
      .all() as { rowid: number; chat_jid: string; timestamp: number; text: string }[];
    const insert = this.db.prepare(`INSERT OR REPLACE INTO message_vectors (rowid, chat_jid, timestamp, vec) VALUES (?, ?, ?, ?)`);
    const tx = this.db.transaction((rows: typeof missing) => {
      for (const r of rows) insert.run(r.rowid, r.chat_jid, r.timestamp, toBlob(vectorize(r.text)));
    });
    tx(missing);
    return missing.length;
  }

  vectorCandidates(chatJid?: string): { rowid: number; timestamp: number; vec: Buffer }[] {
    if (chatJid) {
      return this.db
        .prepare(`SELECT rowid, timestamp, vec FROM message_vectors WHERE chat_jid = ?`)
        .all(chatJid) as { rowid: number; timestamp: number; vec: Buffer }[];
    }
    return this.db.prepare(`SELECT rowid, timestamp, vec FROM message_vectors`).all() as {
      rowid: number;
      timestamp: number;
      vec: Buffer;
    }[];
  }

  messagesByRowids(rowids: number[]): (MessageRow & { rowid: number })[] {
    if (rowids.length === 0) return [];
    const placeholders = rowids.map(() => "?").join(",");
    return this.db
      .prepare(
        `SELECT rowid, id, chat_jid, sender_jid, from_me, timestamp, text, message_type, quoted_id
         FROM messages WHERE rowid IN (${placeholders})`
      )
      .all(...rowids) as (MessageRow & { rowid: number })[];
  }

  /**
   * Segment a chat's history into conversation episodes (silence gap > 3h).
   * Existing episodes keep their agent-written summaries when boundaries match.
   */
  rebuildEpisodes(chatJid: string, gapMs = 3 * 3600_000): number {
    const msgs = this.db
      .prepare(`SELECT timestamp FROM messages WHERE chat_jid = ? ORDER BY timestamp ASC`)
      .all(chatJid) as { timestamp: number }[];
    if (msgs.length === 0) return 0;

    const episodes: { start: number; end: number; count: number }[] = [];
    let start = msgs[0]!.timestamp;
    let prev = start;
    let count = 0;
    for (const m of msgs) {
      if (m.timestamp - prev > gapMs) {
        episodes.push({ start, end: prev, count });
        start = m.timestamp;
        count = 0;
      }
      prev = m.timestamp;
      count++;
    }
    episodes.push({ start, end: prev, count });

    const upsert = this.db.prepare(
      `INSERT INTO episodes (chat_jid, start_ts, end_ts, message_count)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(chat_jid, start_ts) DO UPDATE SET end_ts = excluded.end_ts, message_count = excluded.message_count`
    );
    const tx = this.db.transaction(() => {
      for (const ep of episodes) upsert.run(chatJid, ep.start, ep.end, ep.count);
    });
    tx();
    return episodes.length;
  }

  listEpisodes(chatJid: string, limit = 20): { id: number; chat_jid: string; start_ts: number; end_ts: number; message_count: number; summary: string | null }[] {
    return this.db
      .prepare(
        `SELECT id, chat_jid, start_ts, end_ts, message_count, summary
         FROM episodes WHERE chat_jid = ? ORDER BY start_ts DESC LIMIT ?`
      )
      .all(chatJid, limit) as { id: number; chat_jid: string; start_ts: number; end_ts: number; message_count: number; summary: string | null }[];
  }

  getEpisode(id: number): { id: number; chat_jid: string; start_ts: number; end_ts: number; message_count: number; summary: string | null } | null {
    return (
      (this.db
        .prepare(`SELECT id, chat_jid, start_ts, end_ts, message_count, summary FROM episodes WHERE id = ?`)
        .get(id) as { id: number; chat_jid: string; start_ts: number; end_ts: number; message_count: number; summary: string | null } | undefined) ?? null
    );
  }

  setEpisodeSummary(id: number, summary: string): void {
    this.db
      .prepare(`UPDATE episodes SET summary = ?, summary_vec = ? WHERE id = ?`)
      .run(summary, toBlob(vectorize(summary)), id);
  }

  episodesWithSummaries(chatJid?: string): { id: number; chat_jid: string; start_ts: number; end_ts: number; message_count: number; summary: string; summary_vec: Buffer }[] {
    const where = chatJid ? "AND chat_jid = ?" : "";
    const args = chatJid ? [chatJid] : [];
    return this.db
      .prepare(
        `SELECT id, chat_jid, start_ts, end_ts, message_count, summary, summary_vec
         FROM episodes WHERE summary IS NOT NULL AND summary_vec IS NOT NULL ${where}`
      )
      .all(...args) as { id: number; chat_jid: string; start_ts: number; end_ts: number; message_count: number; summary: string; summary_vec: Buffer }[];
  }

  /** All messages of a chat in a time range (for episode reading/summarizing). */
  messagesInRange(chatJid: string, startTs: number, endTs: number, limit = 500): MessageRow[] {
    return this.db
      .prepare(
        `SELECT id, chat_jid, sender_jid, from_me, timestamp, text, message_type, quoted_id
         FROM messages WHERE chat_jid = ? AND timestamp >= ? AND timestamp <= ?
         ORDER BY timestamp ASC LIMIT ?`
      )
      .all(chatJid, startTs, endTs, limit) as MessageRow[];
  }

  /** Full bidirectional history of a chat — needed for dynamics analysis. */
  allMessages(chatJid: string, limit = 2000): MessageRow[] {
    return this.db
      .prepare(
        `SELECT id, chat_jid, sender_jid, from_me, timestamp, text, message_type, quoted_id
         FROM messages WHERE chat_jid = ? ORDER BY timestamp DESC LIMIT ?`
      )
      .all(chatJid, limit) as MessageRow[];
  }

  // ── attention & activity ─────────────────────────────────

  /** Chats the user engages with most — the basis for VIP triage. */
  topChats(limit = 15): { chat_jid: string; total: number }[] {
    return this.db
      .prepare(
        `SELECT chat_jid, COUNT(*) AS total FROM messages
         WHERE chat_jid NOT LIKE '%@g.us'
         GROUP BY chat_jid ORDER BY total DESC LIMIT ?`
      )
      .all(limit) as { chat_jid: string; total: number }[];
  }

  /**
   * Inbound-message counts per (weekday, hour) over a recent window.
   * Feeds the "is it worth staying online right now?" prediction.
   */
  inboundActivityHistogram(windowDays = 56, chatJid?: string): { dow: number; hour: number; count: number }[] {
    const since = Date.now() - windowDays * 24 * 3600_000;
    const filter = chatJid ? "AND chat_jid = ?" : "";
    const args: (number | string)[] = chatJid ? [since, chatJid] : [since];
    // SQLite strftime works on seconds; timestamps are ms. '%w'=weekday, '%H'=hour, localtime
    return this.db
      .prepare(
        `SELECT CAST(strftime('%w', timestamp / 1000, 'unixepoch', 'localtime') AS INTEGER) AS dow,
                CAST(strftime('%H', timestamp / 1000, 'unixepoch', 'localtime') AS INTEGER) AS hour,
                COUNT(*) AS count
         FROM messages
         WHERE from_me = 0 AND timestamp >= ? ${filter}
         GROUP BY dow, hour`
      )
      .all(...args) as { dow: number; hour: number; count: number }[];
  }

  /** Compact catch-up: what arrived per chat since a timestamp. */
  digestSince(sinceTs: number, limit = 40): {
    chat_jid: string;
    display_name: string | null;
    is_group: number;
    incoming: number;
    last_ts: number;
    last_text: string | null;
  }[] {
    return this.db
      .prepare(
        `SELECT m.chat_jid,
                COALESCE(c.name, ct.name, ct.notify_name) AS display_name,
                COALESCE(c.is_group, 0) AS is_group,
                COUNT(*) AS incoming,
                MAX(m.timestamp) AS last_ts,
                (SELECT text FROM messages m2
                  WHERE m2.chat_jid = m.chat_jid AND m2.from_me = 0
                  ORDER BY m2.timestamp DESC LIMIT 1) AS last_text
         FROM messages m
         LEFT JOIN chats c ON c.jid = m.chat_jid
         LEFT JOIN contacts ct ON ct.jid = m.chat_jid
         WHERE m.from_me = 0 AND m.timestamp > ?
         GROUP BY m.chat_jid
         ORDER BY last_ts DESC
         LIMIT ?`
      )
      .all(sinceTs, limit) as {
      chat_jid: string;
      display_name: string | null;
      is_group: number;
      incoming: number;
      last_ts: number;
      last_text: string | null;
    }[];
  }

  // ── productivity: inbox, commitments, group members ──────

  /**
   * Chats whose LAST message came from the other person — i.e. the ball is in
   * the user's court. The backbone of "what do I still owe a reply to?".
   */
  pendingReplies(limit = 30, includeGroups = false): {
    chat_jid: string; display_name: string | null; is_group: number;
    last_ts: number; last_text: string | null; waiting_hours: number; incoming_since: number;
  }[] {
    const groupFilter = includeGroups ? "" : "AND m.chat_jid NOT LIKE '%@g.us'";
    return this.db
      .prepare(
        `WITH last AS (
           SELECT chat_jid, MAX(timestamp) last_ts FROM messages GROUP BY chat_jid
         )
         SELECT m.chat_jid,
                COALESCE(c.name, ct.name, ct.notify_name, ct2.name, ct2.notify_name) display_name,
                COALESCE(c.is_group, 0) is_group,
                m.timestamp last_ts,
                m.text last_text,
                ROUND((? - m.timestamp) / 3600000.0, 1) waiting_hours,
                (SELECT COUNT(*) FROM messages x
                  WHERE x.chat_jid = m.chat_jid AND x.from_me = 0
                    AND x.timestamp > COALESCE((SELECT MAX(y.timestamp) FROM messages y WHERE y.chat_jid = m.chat_jid AND y.from_me = 1), 0)
                ) incoming_since
         FROM messages m
         JOIN last l ON l.chat_jid = m.chat_jid AND l.last_ts = m.timestamp
         LEFT JOIN chats c ON c.jid = m.chat_jid
         LEFT JOIN contacts ct ON ct.jid = m.chat_jid
         LEFT JOIN jid_map jm ON jm.lid = m.chat_jid OR jm.pn = m.chat_jid
         LEFT JOIN contacts ct2 ON ct2.jid = (CASE WHEN jm.lid = m.chat_jid THEN jm.pn ELSE jm.lid END)
         WHERE m.from_me = 0 ${groupFilter} ${conversational("m.chat_jid")}
         ORDER BY m.timestamp DESC LIMIT ?`
      )
      .all(Date.now(), limit) as ReturnType<Store["pendingReplies"]>;
  }

  /** Outgoing messages that sound like a promise, with whether the user wrote again after. */
  commitmentCandidates(sinceDays = 21, limit = 200): {
    chat_jid: string; display_name: string | null; timestamp: number; text: string;
  }[] {
    const since = Date.now() - sinceDays * 86_400_000;
    return this.db
      .prepare(
        `SELECT m.chat_jid, COALESCE(c.name, ct.name, ct.notify_name) display_name, m.timestamp, m.text
         FROM messages m
         LEFT JOIN chats c ON c.jid = m.chat_jid
         LEFT JOIN contacts ct ON ct.jid = m.chat_jid
         WHERE m.from_me = 1 AND m.text IS NOT NULL AND m.timestamp > ?
         ORDER BY m.timestamp DESC LIMIT ?`
      )
      .all(since, limit) as ReturnType<Store["commitmentCandidates"]>;
  }

  /**
   * Participants of a group with how much each one talks — the unit of group
   * profiling. Group participant jids are almost always the @lid form
   * (WhatsApp hides phone numbers inside groups), so the jid_map cross-
   * reference matters even more here than in listChats: a member you have
   * saved as a contact under their phone number would otherwise show as a
   * bare number instead of their name.
   */
  groupMembers(groupJid: string, minMessages = 20): { sender_jid: string; display_name: string | null; total: number }[] {
    return this.db
      .prepare(
        `SELECT m.sender_jid, COALESCE(ct.name, ct.notify_name, ct2.name, ct2.notify_name) display_name, COUNT(*) total
         FROM messages m
         LEFT JOIN contacts ct ON ct.jid = m.sender_jid
         LEFT JOIN jid_map jm ON jm.lid = m.sender_jid OR jm.pn = m.sender_jid
         LEFT JOIN contacts ct2 ON ct2.jid = (CASE WHEN jm.lid = m.sender_jid THEN jm.pn ELSE jm.lid END)
         WHERE m.chat_jid = ? AND m.from_me = 0 AND m.sender_jid IS NOT NULL AND m.text IS NOT NULL
         GROUP BY m.sender_jid HAVING total >= ? ORDER BY total DESC`
      )
      .all(groupJid, minMessages) as { sender_jid: string; display_name: string | null; total: number }[];
  }

  /** All messages a specific participant wrote in a group. */
  memberMessages(groupJid: string, senderJid: string, limit = 1000): MessageRow[] {
    return this.db
      .prepare(
        `SELECT id, chat_jid, sender_jid, from_me, timestamp, text, message_type, quoted_id
         FROM messages WHERE chat_jid = ? AND sender_jid = ? AND text IS NOT NULL
         ORDER BY timestamp DESC LIMIT ?`
      )
      .all(groupJid, senderJid, limit) as MessageRow[];
  }

  // ── sticker library ──────────────────────────────────────

  upsertSticker(s: { id: string; origin: string; pack: string | null; mood: string | null; filePath: string | null; chatJid: string | null; msgId: string | null; description: string | null }): void {
    this.db
      .prepare(
        `INSERT INTO sticker_library (id, origin, pack, mood, file_path, chat_jid, msg_id, description, created_at)
         VALUES (@id, @origin, @pack, @mood, @filePath, @chatJid, @msgId, @description, @createdAt)
         ON CONFLICT(id) DO UPDATE SET mood = excluded.mood, file_path = excluded.file_path, description = COALESCE(excluded.description, sticker_library.description)`
      )
      .run({ ...s, createdAt: Date.now() });
  }

  listStickers(opts: { mood?: string; origin?: string; limit?: number } = {}): {
    id: string; origin: string; pack: string | null; mood: string | null; file_path: string | null; chat_jid: string | null; msg_id: string | null; uses: number; description: string | null;
  }[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.mood) { where.push("mood = ?"); args.push(opts.mood); }
    if (opts.origin) { where.push("origin = ?"); args.push(opts.origin); }
    args.push(opts.limit ?? 30);
    return this.db
      .prepare(`SELECT * FROM sticker_library ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY uses DESC, origin ASC LIMIT ?`)
      .all(...args) as ReturnType<Store["listStickers"]>;
  }

  getSticker(id: string): { id: string; origin: string; mood: string | null; file_path: string | null; chat_jid: string | null; msg_id: string | null } | null {
    return (this.db.prepare(`SELECT id, origin, mood, file_path, chat_jid, msg_id FROM sticker_library WHERE id = ?`).get(id) as
      | { id: string; origin: string; mood: string | null; file_path: string | null; chat_jid: string | null; msg_id: string | null }
      | undefined) ?? null;
  }

  markStickerUsed(id: string): void {
    this.db.prepare(`UPDATE sticker_library SET uses = uses + 1, last_used_at = ? WHERE id = ?`).run(Date.now(), id);
  }

  /** Stickers the user sent, with the text that preceded them (for mood inference). */
  ownStickerMessages(limit = 2000): { chat_jid: string; msg_id: string; prev_text: string | null }[] {
    return this.db
      .prepare(
        `SELECT m.chat_jid, m.id msg_id,
           (SELECT p.text FROM messages p
             WHERE p.chat_jid = m.chat_jid AND p.timestamp < m.timestamp AND p.text IS NOT NULL AND p.text NOT LIKE '[%'
             ORDER BY p.timestamp DESC LIMIT 1) prev_text
         FROM messages m
         WHERE m.message_type = 'sticker' AND m.from_me = 1
         ORDER BY m.timestamp DESC LIMIT ?`
      )
      .all(limit) as { chat_jid: string; msg_id: string; prev_text: string | null }[];
  }

  bumpStickerHabit(chatJid: string, mood: string): void {
    this.db
      .prepare(`INSERT INTO sticker_habits (chat_jid, mood, count) VALUES (?, ?, 1) ON CONFLICT(chat_jid, mood) DO UPDATE SET count = count + 1`)
      .run(chatJid, mood);
  }

  stickerHabits(chatJid: string): { mood: string; count: number }[] {
    return this.db.prepare(`SELECT mood, count FROM sticker_habits WHERE chat_jid = ? ORDER BY count DESC`).all(chatJid) as { mood: string; count: number }[];
  }

  /** How sticker-heavy the user is with this contact. */
  stickerUsageFor(chatJid: string): { stickers: number; outgoing: number } {
    const r = this.db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN message_type='sticker' THEN 1 ELSE 0 END),0) stickers,
                COUNT(*) outgoing
         FROM messages WHERE chat_jid = ? AND from_me = 1`
      )
      .get(chatJid) as { stickers: number; outgoing: number } | undefined;
    return r ?? { stickers: 0, outgoing: 0 };
  }

  // ── suggested events (brute-force actionables) ───────────

  addSuggestedEvent(e: { chatJid: string; title: string; whenTs: number | null; rawText: string; sourceMsgId: string }): void {
    this.db
      .prepare(
        `INSERT INTO suggested_events (chat_jid, title, when_ts, raw_text, source_msg_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'suggested', ?)
         ON CONFLICT(chat_jid, title) DO NOTHING`
      )
      .run(e.chatJid, e.title, e.whenTs, e.rawText, e.sourceMsgId, Date.now());
  }

  listSuggestedEvents(status = "suggested", limit = 50): {
    id: number; chat_jid: string; title: string; when_ts: number | null; raw_text: string | null; status: string;
  }[] {
    return this.db
      .prepare(`SELECT id, chat_jid, title, when_ts, raw_text, status FROM suggested_events WHERE status = ? ORDER BY (when_ts IS NULL), when_ts ASC LIMIT ?`)
      .all(status, limit) as { id: number; chat_jid: string; title: string; when_ts: number | null; raw_text: string | null; status: string }[];
  }

  getSuggestedEvent(id: number): { id: number; chat_jid: string; title: string; when_ts: number | null } | null {
    return (this.db.prepare(`SELECT id, chat_jid, title, when_ts FROM suggested_events WHERE id = ?`).get(id) as
      | { id: number; chat_jid: string; title: string; when_ts: number | null }
      | undefined) ?? null;
  }

  setSuggestedStatus(id: number, status: string): boolean {
    return this.db.prepare(`UPDATE suggested_events SET status = ? WHERE id = ?`).run(status, id).changes > 0;
  }

  // ── LID ↔ phone mapping & chat resolution ────────────────

  /** The linked account's own identities; null until the first login. */
  private self: { pn: string | null; lid: string | null } = { pn: null, lid: null };

  /**
   * Tell the store who "me" is. Our own @lid and phone are the one pair we
   * know for certain, so they are pinned here and nothing else may claim
   * them. A guess once mapped the self chat to Meta AI's number, and the
   * self chat took that name.
   */
  setSelf(pn: string | null, lid: string | null): void {
    const bare = (j: string | null) => (j ? j.replace(/:\d+@/, "@") : null);
    this.self = { pn: bare(pn), lid: bare(lid) };
    const { pn: p, lid: l } = this.self;
    if (!p || !l) return;
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM jid_map WHERE (lid = ? AND pn <> ?) OR (pn = ? AND lid <> ?)`).run(l, p, p, l);
      this.db.prepare(`INSERT INTO jid_map (lid, pn) VALUES (?, ?) ON CONFLICT(lid) DO UPDATE SET pn = excluded.pn`).run(l, p);
      // Names mirrored onto the self chat came from someone else.
      this.db.prepare(`UPDATE chats SET name = NULL WHERE jid IN (?, ?)`).run(l, p);
      this.db.prepare(`UPDATE contacts SET name = (SELECT name FROM contacts WHERE jid = ?) WHERE jid = ?`).run(p, l);
    })();
  }

  /** Is this jid (either half) the linked account itself? */
  isSelf(jid: string): boolean {
    const j = jid.replace(/:\d+@/, "@");
    return j === this.self.pn || j === this.self.lid;
  }

  selfJids(): { pn: string | null; lid: string | null } {
    return { ...this.self };
  }

  /** Link the two halves of one person. Returns false when the pair is refused. */
  mapJids(lid: string, pn: string): boolean {
    if (!lid.endsWith("@lid") || !pn.includes("@")) return false;
    // Our own identities are pinned by setSelf; no other pairing may claim them.
    const { pn: sp, lid: sl } = this.self;
    if (sl && sp && (lid === sl) !== (pn === sp)) return false;
    this.db.prepare(`INSERT INTO jid_map (lid, pn) VALUES (?, ?) ON CONFLICT(lid) DO UPDATE SET pn = excluded.pn`).run(lid, pn);
    return true;
  }

  // ── presence (online / last seen) ────────────────────────

  upsertPresence(p: { jid: string; state: string; lastSeen?: number | null }): void {
    // Never overwrite a known lastSeen with null: WhatsApp sends "available"
    // updates without a timestamp, and losing the previous one would make a
    // contact who just came online look like we never saw them.
    this.db
      .prepare(
        `INSERT INTO presence (jid, state, last_seen, updated_at)
         VALUES (@jid, @state, @lastSeen, @now)
         ON CONFLICT(jid) DO UPDATE SET
           state = excluded.state,
           last_seen = COALESCE(excluded.last_seen, presence.last_seen),
           updated_at = excluded.updated_at`
      )
      .run({ jid: p.jid, state: p.state, lastSeen: p.lastSeen ?? null, now: Date.now() });
  }

  getPresence(jid: string): { jid: string; state: string; last_seen: number | null; updated_at: number } | null {
    const direct = this.db.prepare(`SELECT * FROM presence WHERE jid = ?`).get(jid) as
      | { jid: string; state: string; last_seen: number | null; updated_at: number }
      | undefined;
    if (direct) return direct;
    // Presence can arrive under the other half of the @lid/phone pair.
    const alt = jid.endsWith("@lid") ? this.pnForLid(jid) : this.lidForPn(jid);
    if (!alt) return null;
    return (this.db.prepare(`SELECT * FROM presence WHERE jid = ?`).get(alt) as
      | { jid: string; state: string; last_seen: number | null; updated_at: number }
      | undefined) ?? null;
  }

  lidForPn(pn: string): string | null {
    return (this.db.prepare(`SELECT lid FROM jid_map WHERE pn = ?`).get(pn) as { lid: string } | undefined)?.lid ?? null;
  }

  pnForLid(lid: string): string | null {
    return (this.db.prepare(`SELECT pn FROM jid_map WHERE lid = ?`).get(lid) as { pn: string } | undefined)?.pn ?? null;
  }

  private messageCount(jid: string): { total: number; outgoing: number } {
    return (
      (this.db.prepare(`SELECT COUNT(*) total, COALESCE(SUM(from_me),0) outgoing FROM messages WHERE chat_jid = ?`).get(jid) as
        | { total: number; outgoing: number }
        | undefined) ?? { total: 0, outgoing: 0 }
    );
  }

  /**
   * Resolve a name / phone / JID to the chat JID(s) that actually hold messages.
   * Codifies the manual work needed because of the @lid privacy split:
   *   1. direct JID with messages,
   *   2. the mapped counterpart (lid↔pn),
   *   3. contacts matching by name/number → their jids + mapped lids,
   *   4. last resort: FTS the name in the user's own outgoing greetings.
   */
  resolveChat(query: string): { jid: string; displayName: string | null; total: number; outgoing: number; via: string }[] {
    // Each candidate carries a confidence weight; explicit id/number/contact
    // matches outrank the fuzzy greeting fallback, and among greetings the one
    // you address by name most often wins (that's the person, not a mention).
    const candidates = new Map<string, { via: string; weight: number }>();
    const add = (jid: string | null | undefined, via: string, weight: number) => {
      if (!jid) return;
      const prev = candidates.get(jid);
      if (!prev || weight > prev.weight) candidates.set(jid, { via, weight });
    };
    const q = query.trim();

    if (q.includes("@")) {
      add(q, "direct", 1000);
      add(this.pnForLid(q), "map:lid→pn", 950);
      add(this.lidForPn(q), "map:pn→lid", 950);
    } else if (/^\+?[\d\s-]{6,}$/.test(q)) {
      const pn = `${q.replace(/[^\d]/g, "")}@s.whatsapp.net`;
      add(pn, "phone", 900);
      add(this.lidForPn(pn), "phone→lid", 950);
    }

    if (!q.includes("@")) {
      const like = `%${q.replace(/[%_]/g, "")}%`;
      const contacts = this.db
        .prepare(`SELECT jid FROM contacts WHERE name LIKE ? OR notify_name LIKE ? LIMIT 10`)
        .all(like, like) as { jid: string }[];
      for (const c of contacts) {
        add(c.jid, "name→contact", 800);
        add(this.lidForPn(c.jid), "name→contact→lid", 850);
      }
      for (const c of this.db.prepare(`SELECT jid FROM chats WHERE name LIKE ? LIMIT 10`).all(like) as { jid: string }[]) {
        add(c.jid, "name→chat", 700);
      }

      // FTS fallback: chats where the user addresses this name in OUTGOING text.
      // Rank by how often — you greet a real contact by name repeatedly, but
      // only mention someone in passing once elsewhere.
      const ftsName = q.split(/\s+/)[0];
      if (ftsName && ftsName.length >= 3) {
        try {
          const hits = this.db
            .prepare(
              `SELECT m.chat_jid, COUNT(*) n FROM messages_fts f JOIN messages m ON m.rowid=f.rowid
               WHERE messages_fts MATCH ? AND m.from_me=1 GROUP BY m.chat_jid ORDER BY n DESC LIMIT 10`
            )
            .all(`"${ftsName.replace(/"/g, "")}"`) as { chat_jid: string; n: number }[];
          for (const h of hits) add(h.chat_jid, `fts:greeting×${h.n}`, 100 + h.n);
        } catch {
          // FTS syntax guard
        }
      }
    }

    return [...candidates.entries()]
      .map(([jid, { via, weight }]) => ({ jid, via, weight, ...this.messageCount(jid), displayName: this.resolveDisplayName(jid) }))
      .filter((r) => r.total > 0)
      .sort((a, b) => b.weight - a.weight || b.total - a.total)
      .map(({ weight, ...r }) => r);
  }

  /**
   * One-time opportunistic backfill for history captured before per-message
   * alt-key mapping existed: for each named contact, find the @lid chat where
   * the user greets that first name repeatedly and (conservatively) persist the
   * phone↔lid link + mirror the name onto the @lid chat. Idempotent.
   */
  backfillJidMapFromGreetings(): number {
    const contacts = this.db
      .prepare(
        `SELECT jid, name FROM contacts WHERE name IS NOT NULL AND jid LIKE '%@s.whatsapp.net'
         -- service accounts (WhatsApp itself, Meta AI, business assistants) are not people
         AND jid NOT LIKE '0@%' AND jid NOT LIKE '1313555%'`
      )
      .all() as { jid: string; name: string }[];
    const findLid = this.db.prepare(
      `SELECT m.chat_jid j, COUNT(*) n FROM messages_fts f JOIN messages m ON m.rowid=f.rowid
       WHERE messages_fts MATCH ? AND m.from_me=1 AND m.chat_jid LIKE '%@lid'
       GROUP BY m.chat_jid ORDER BY n DESC LIMIT 2`
    );

    // Pass 1: which @lid chat would each contact's first name point at?
    const claims = new Map<string, { jid: string; name: string }[]>();
    for (const c of contacts) {
      if (this.isSelf(c.jid)) continue;
      const mapped = this.lidForPn(c.jid);
      const first = c.name.trim().split(/\s+/)[0];
      if (!first || first.length < 3) continue;
      let rows: { j: string; n: number }[] = [];
      try {
        rows = findLid.all(`"${first.replace(/"/g, "")}"`) as { j: string; n: number }[];
      } catch {
        continue;
      }
      // Strong signal only: written ≥3× and clearly ahead of #2.
      const top = rows[0];
      if (!top || top.n < 3) continue;
      if (rows[1] && rows[1].n * 2 > top.n) continue;
      if (mapped && mapped !== top.j) continue; // already linked elsewhere, by WhatsApp itself
      if (this.isSelf(top.j)) continue; // your notes mention everyone; they are nobody's chat
      const list = claims.get(top.j) ?? [];
      list.push(c);
      claims.set(top.j, list);
    }

    // Pass 2: a chat claimed by several names is a notes or shared chat, not
    // one person — that is how the self chat became "Meta AI". Undo an old
    // guess there once; link only chats exactly one contact points at.
    const undoDone = this.db.prepare(`SELECT 1 FROM meta WHERE key = 'greeting_map_v2'`).get();
    let mapped = 0;
    this.db.transaction(() => {
      for (const [lid, list] of claims) {
        const current = this.pnForLid(lid);
        if (list.length > 1) {
          const guessed = list.find((c) => c.jid === current);
          if (!undoDone && guessed) {
            this.db.prepare(`DELETE FROM jid_map WHERE lid = ?`).run(lid);
            this.db.prepare(`UPDATE chats SET name = NULL WHERE jid = ? AND name = ?`).run(lid, guessed.name);
            this.db.prepare(`UPDATE contacts SET name = NULL WHERE jid = ? AND name = ?`).run(lid, guessed.name);
          }
          continue;
        }
        if (current) continue; // never overwrite an existing link
        const c = list[0]!;
        this.mapJids(lid, c.jid);
        this.upsertContact({ jid: lid, name: c.name });
        this.upsertChat({ jid: lid, name: c.name });
        mapped++;
      }
      this.db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('greeting_map_v2', ?)`).run(String(Date.now()));
    })();
    return mapped;
  }

  /** Ranked worklist for agents building the knowledge base: who's worth analyzing. */
  analysisTargets(limit = 25, minOutgoing = 15): { jid: string; displayName: string | null; total: number; outgoing: number; isGroup: boolean; hasFacts: boolean }[] {
    const rows = this.db
      .prepare(
        `SELECT m.chat_jid jid, COUNT(*) total, COALESCE(SUM(m.from_me),0) outgoing
         FROM messages m WHERE 1=1 ${conversational("m.chat_jid")}
         GROUP BY m.chat_jid HAVING outgoing >= ? ORDER BY outgoing DESC LIMIT ?`
      )
      .all(minOutgoing, limit) as { jid: string; total: number; outgoing: number }[];
    return rows.map((r) => ({
      jid: r.jid,
      displayName: this.resolveDisplayName(r.jid),
      total: r.total,
      outgoing: r.outgoing,
      isGroup: r.jid.endsWith("@g.us"),
      hasFacts: (this.db.prepare(`SELECT 1 FROM contact_facts WHERE jid = ? LIMIT 1`).get(r.jid) as unknown) !== undefined,
    }));
  }

  // ── contact facts (memory dimension 1) ───────────────────

  /** Normalize so "le gusta el reggaetón" and "Le gusta el reggaeton" dedupe. */
  private static normFact(fact: string): string {
    return fact
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .replace(/[^\p{L}\p{N}\s]/gu, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  /** Insert a fact, or update it in place if a near-identical one exists (dynamic memory). */
  upsertFact(entry: { jid: string; category: string; fact: string; confidence?: number; sourceMsgId?: string | null }): { id: number; updated: boolean } {
    const norm = Store.normFact(entry.fact);
    const now = Date.now();
    const existing = this.db.prepare(`SELECT id FROM contact_facts WHERE jid = ? AND fact_norm = ?`).get(entry.jid, norm) as
      | { id: number }
      | undefined;
    if (existing) {
      this.db
        .prepare(`UPDATE contact_facts SET category = ?, fact = ?, confidence = ?, source_msg_id = COALESCE(?, source_msg_id), updated_at = ? WHERE id = ?`)
        .run(entry.category, entry.fact, entry.confidence ?? 0.8, entry.sourceMsgId ?? null, now, existing.id);
      return { id: existing.id, updated: true };
    }
    const result = this.db
      .prepare(
        `INSERT INTO contact_facts (jid, category, fact, fact_norm, confidence, source_msg_id, learned_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(entry.jid, entry.category, entry.fact, norm, entry.confidence ?? 0.8, entry.sourceMsgId ?? null, now, now);
    return { id: Number(result.lastInsertRowid), updated: false };
  }

  listFacts(jid: string): FactRow[] {
    return this.db
      .prepare(
        `SELECT id, jid, category, fact, confidence, source_msg_id, learned_at, updated_at
         FROM contact_facts WHERE jid = ? ORDER BY category, updated_at DESC`
      )
      .all(jid) as FactRow[];
  }

  deleteFact(id: number, jid?: string): boolean {
    const result = jid
      ? this.db.prepare(`DELETE FROM contact_facts WHERE id = ? AND jid = ?`).run(id, jid)
      : this.db.prepare(`DELETE FROM contact_facts WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  /** Categories that already have at least one fact for this contact. */
  factCategories(jid: string): Set<string> {
    const rows = this.db.prepare(`SELECT DISTINCT category FROM contact_facts WHERE jid = ?`).all(jid) as { category: string }[];
    return new Set(rows.map((r) => r.category));
  }

  // ── chat tags (special chats) ────────────────────────────

  tagChat(jid: string, tag: string): void {
    this.db.prepare(`INSERT OR IGNORE INTO chat_tags (jid, tag, added_at) VALUES (?, ?, ?)`).run(jid, tag.toLowerCase(), Date.now());
  }

  untagChat(jid: string, tag: string): boolean {
    return this.db.prepare(`DELETE FROM chat_tags WHERE jid = ? AND tag = ?`).run(jid, tag.toLowerCase()).changes > 0;
  }

  chatTags(jid: string): string[] {
    return (this.db.prepare(`SELECT tag FROM chat_tags WHERE jid = ? ORDER BY tag`).all(jid) as { tag: string }[]).map((r) => r.tag);
  }

  listTaggedChats(): { jid: string; tags: string[] }[] {
    const rows = this.db.prepare(`SELECT jid, tag FROM chat_tags ORDER BY jid`).all() as { jid: string; tag: string }[];
    const map = new Map<string, string[]>();
    for (const r of rows) {
      const arr = map.get(r.jid) ?? [];
      arr.push(r.tag);
      map.set(r.jid, arr);
    }
    return [...map.entries()].map(([jid, tags]) => ({ jid, tags }));
  }

  // ── playbook cache ───────────────────────────────────────

  getCachedPlaybook(tag: string, situationHash: string): PlaybookCacheRow | null {
    return (
      (this.db.prepare(`SELECT * FROM playbook_cache WHERE tag = ? AND situation_hash = ?`).get(tag, situationHash) as PlaybookCacheRow | undefined) ??
      null
    );
  }

  cachePlaybook(entry: { tag: string; situationHash: string; question: string; answer: string; citationsJson: string | null }): void {
    this.db
      .prepare(
        `INSERT INTO playbook_cache (tag, situation_hash, question, answer, citations_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(tag, situation_hash) DO UPDATE SET question = excluded.question, answer = excluded.answer, citations_json = excluded.citations_json, created_at = excluded.created_at`
      )
      .run(entry.tag, entry.situationHash, entry.question, entry.answer, entry.citationsJson, Date.now());
  }

  // ── media stubs ──────────────────────────────────────────

  upsertMedia(m: MediaRow): void {
    this.db
      .prepare(
        `INSERT INTO media (chat_jid, msg_id, kind, mimetype, media_key, direct_path, url, file_length, seconds, is_ptt, caption, timestamp)
         VALUES (@chat_jid, @msg_id, @kind, @mimetype, @media_key, @direct_path, @url, @file_length, @seconds, @is_ptt, @caption, @timestamp)
         ON CONFLICT(chat_jid, msg_id) DO UPDATE SET
           direct_path = excluded.direct_path, url = excluded.url, media_key = excluded.media_key`
      )
      .run(m);
  }

  getMedia(chatJid: string, msgId: string): MediaRow | null {
    return (this.db.prepare(`SELECT * FROM media WHERE chat_jid = ? AND msg_id = ?`).get(chatJid, msgId) as MediaRow | undefined) ?? null;
  }

  // ── error log (anti-fraud) ───────────────────────────────

  logErrorRow(entry: { operation: string; chatJid?: string | null; error: string; contextJson?: string | null; client?: string | null }): void {
    this.db
      .prepare(`INSERT INTO error_log (ts, operation, chat_jid, error, context_json, client) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(Date.now(), entry.operation, entry.chatJid ?? null, entry.error, entry.contextJson ?? null, entry.client ?? null);
  }

  recentErrors(limit = 30, chatJid?: string): ErrorRow[] {
    if (chatJid) {
      return this.db.prepare(`SELECT * FROM error_log WHERE chat_jid = ? ORDER BY ts DESC LIMIT ?`).all(chatJid, limit) as ErrorRow[];
    }
    return this.db.prepare(`SELECT * FROM error_log ORDER BY ts DESC LIMIT ?`).all(limit) as ErrorRow[];
  }

  // ── calendar events ──────────────────────────────────────

  createEvent(e: { chatJid?: string | null; title: string; startTs: number; endTs?: number | null; notifyTs?: number | null; createdBy?: string | null; notes?: string | null }): EventRow {
    const result = this.db
      .prepare(
        `INSERT INTO events (chat_jid, title, start_ts, end_ts, notify_ts, status, created_by, notes, created_at)
         VALUES (?, ?, ?, ?, ?, 'scheduled', ?, ?, ?)`
      )
      .run(e.chatJid ?? null, e.title, e.startTs, e.endTs ?? null, e.notifyTs ?? null, e.createdBy ?? null, e.notes ?? null, Date.now());
    return this.getEvent(Number(result.lastInsertRowid))!;
  }

  getEvent(id: number): EventRow | null {
    return (this.db.prepare(`SELECT * FROM events WHERE id = ?`).get(id) as EventRow | undefined) ?? null;
  }

  listEvents(opts: { includeDone?: boolean; withinDays?: number; limit?: number } = {}): EventRow[] {
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (!opts.includeDone) clauses.push(`status IN ('scheduled','fired')`);
    if (opts.withinDays !== undefined) {
      clauses.push(`start_ts <= ?`);
      args.push(Date.now() + opts.withinDays * 86_400_000);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    args.push(opts.limit ?? 50);
    return this.db.prepare(`SELECT * FROM events ${where} ORDER BY start_ts ASC LIMIT ?`).all(...args) as EventRow[];
  }

  setEventStatus(id: number, status: string): boolean {
    return this.db.prepare(`UPDATE events SET status = ? WHERE id = ?`).run(status, id).changes > 0;
  }

  /** Events whose notify time has arrived and haven't been fired yet. Drives the proactive engine. */
  dueEvents(now = Date.now()): EventRow[] {
    return this.db
      .prepare(`SELECT * FROM events WHERE status = 'scheduled' AND notify_ts IS NOT NULL AND notify_ts <= ? ORDER BY notify_ts ASC`)
      .all(now) as EventRow[];
  }

  // ── tasks ────────────────────────────────────────────────

  createTask(t: { title: string; dueTs?: number | null; chatJid?: string | null; notes?: string | null }): TaskRow {
    const result = this.db
      .prepare(`INSERT INTO tasks (title, due_ts, done, chat_jid, notes, created_at) VALUES (?, ?, 0, ?, ?, ?)`)
      .run(t.title, t.dueTs ?? null, t.chatJid ?? null, t.notes ?? null, Date.now());
    return this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(Number(result.lastInsertRowid)) as TaskRow;
  }

  listTasks(includeDone = false): TaskRow[] {
    const where = includeDone ? "" : "WHERE done = 0";
    return this.db.prepare(`SELECT * FROM tasks ${where} ORDER BY (due_ts IS NULL), due_ts ASC, created_at DESC`).all() as TaskRow[];
  }

  completeTask(id: number): boolean {
    return this.db.prepare(`UPDATE tasks SET done = 1 WHERE id = ?`).run(id).changes > 0;
  }

  // ── sent log ─────────────────────────────────────────────

  logSent(entry: { chatJid: string; text: string; clientName: string; dryRun: boolean }): void {
    this.db
      .prepare(
        `INSERT INTO sent_log (chat_jid, text, client_name, timestamp, dry_run)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(entry.chatJid, entry.text, entry.clientName, Date.now(), entry.dryRun ? 1 : 0);
  }

  recentSends(withinMs: number): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM sent_log WHERE timestamp > ? AND dry_run = 0`)
      .get(Date.now() - withinMs) as { n: number };
    return row.n;
  }

  stats(): { chats: number; contacts: number; messages: number; outgoing: number } {
    const one = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      chats: one("SELECT COUNT(*) AS n FROM chats"),
      contacts: one("SELECT COUNT(*) AS n FROM contacts"),
      messages: one("SELECT COUNT(*) AS n FROM messages"),
      outgoing: one("SELECT COUNT(*) AS n FROM messages WHERE from_me = 1"),
    };
  }
}
