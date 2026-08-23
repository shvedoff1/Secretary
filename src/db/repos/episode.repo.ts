import { getDb } from '../client.js';

/**
 * One closed conversation session (see migration 026): a cheap-model condensation
 * of a stretch of chat_message_log, bounded by silence on both sides. `topics` is
 * a short list of lowercase tags used for the context topic index and for search.
 */
export interface ChatEpisode {
  id: number;
  chatId: number;
  startedAt: number;
  endedAt: number;
  messageCount: number;
  summary: string;
  topics: string[];
  createdAt: number;
}

interface EpisodeRow {
  id: number;
  chat_id: number;
  started_at: number;
  ended_at: number;
  message_count: number;
  summary: string;
  topics: string;
  created_at: number;
}

function mapRow(r: EpisodeRow): ChatEpisode {
  return {
    id: r.id,
    chatId: r.chat_id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    messageCount: r.message_count,
    summary: r.summary,
    topics: r.topics
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
    createdAt: r.created_at,
  };
}

/** Store one closed episode. Returns the new row id. */
export function insertEpisode(args: {
  chatId: number;
  startedAt: number;
  endedAt: number;
  messageCount: number;
  summary: string;
  topics: string[];
}): number {
  const res = getDb()
    .prepare(
      `INSERT INTO chat_episode (chat_id, started_at, ended_at, message_count, summary, topics, created_at)
       VALUES (?, ?, ?, ?, ?, ?, unixepoch() * 1000)`,
    )
    .run(
      args.chatId,
      args.startedAt,
      args.endedAt,
      args.messageCount,
      args.summary.trim(),
      args.topics.map((t) => t.trim()).filter(Boolean).join(', '),
    );
  return Number(res.lastInsertRowid);
}

/**
 * The close watermark: log messages at or before this timestamp are already part
 * of some episode. 0 for a chat with no episodes yet.
 */
export function lastEpisodeEnd(chatId: number): number {
  const row = getDb()
    .prepare('SELECT MAX(ended_at) AS w FROM chat_episode WHERE chat_id = ?')
    .get(chatId) as { w: number | null };
  return row.w ?? 0;
}

/** The newest `limit` episodes, returned in chronological order (oldest first). */
export function recentEpisodes(chatId: number, limit: number): ChatEpisode[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM chat_episode WHERE chat_id = ?
       ORDER BY ended_at DESC, id DESC LIMIT ?`,
    )
    .all(chatId, limit) as EpisodeRow[];
  return rows.map(mapRow).reverse();
}

/** Every episode for a chat (chronological) — the search pool for recall. */
export function listEpisodes(chatId: number): ChatEpisode[] {
  const rows = getDb()
    .prepare('SELECT * FROM chat_episode WHERE chat_id = ? ORDER BY ended_at ASC, id ASC')
    .all(chatId) as EpisodeRow[];
  return rows.map(mapRow);
}

/** How many episodes the journal holds for a chat. */
export function episodeCount(chatId: number): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM chat_episode WHERE chat_id = ?')
    .get(chatId) as { n: number };
  return row.n;
}

/**
 * Chats that have log messages NEWER than their episode watermark — the candidates
 * one close tick looks at. Cheap (one grouped query), so the tick can run every
 * minute without touching chats that have nothing new.
 */
export function episodeCandidates(): { chatId: number; newestAt: number; watermark: number }[] {
  const rows = getDb()
    .prepare(
      `SELECT l.chat_id AS chatId, MAX(l.created_at) AS newestAt, COALESCE(e.w, 0) AS watermark
       FROM chat_message_log l
       LEFT JOIN (SELECT chat_id, MAX(ended_at) AS w FROM chat_episode GROUP BY chat_id) e
         ON e.chat_id = l.chat_id
       GROUP BY l.chat_id
       HAVING MAX(l.created_at) > COALESCE(e.w, 0)`,
    )
    .all() as { chatId: number; newestAt: number; watermark: number }[];
  return rows;
}

/** Keep only the newest `keep` episodes per chat; delete the oldest overflow. */
export function pruneEpisodes(chatId: number, keep: number): void {
  getDb()
    .prepare(
      `DELETE FROM chat_episode
       WHERE chat_id = ?
         AND id NOT IN (
           SELECT id FROM chat_episode
           WHERE chat_id = ?
           ORDER BY ended_at DESC, id DESC
           LIMIT ?
         )`,
    )
    .run(chatId, chatId, keep);
}

/** Wipe a chat's whole journal (admin /episodes <chatId> clear). */
export function clearEpisodes(chatId: number): void {
  getDb().prepare('DELETE FROM chat_episode WHERE chat_id = ?').run(chatId);
}
