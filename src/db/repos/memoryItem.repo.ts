import { getDb } from '../client.js';
import {
  effectiveWeight,
  selectForContext,
  selectForPrune,
  MAX_IMPORTANCE,
  MIN_IMPORTANCE,
  REINFORCE_IMPORTANCE_STEP,
  type WeightedItem,
  type ContextSelection,
} from '../../util/memoryWeight.js';

export type MemoryScope = 'chat' | 'user';
export type MemorySource = 'passive' | 'explicit';

/** A stored memory item (one row of chat_memory_item). */
export interface MemoryItem extends WeightedItem {
  chatId: number;
  createdAt: number;
}

/** A new passive fact produced by the extractor before it is persisted. */
export interface MemoryDraft {
  scope: MemoryScope;
  tgUserId: number | null;
  subject: string;
  content: string;
  importance: number;
}

/** A buffered message awaiting the next extraction batch, with its sender. */
export interface MemorySample {
  tgUserId: number;
  senderName: string;
  content: string;
}

// --- sample buffer ----------------------------------------------------------

/** Buffer an incoming message (with its sender) for the next extraction batch. */
export function recordSample(
  chatId: number,
  tgUserId: number,
  senderName: string,
  content: string,
): void {
  getDb()
    .prepare(
      `INSERT INTO chat_memory_sample (chat_id, tg_user_id, sender_name, content, created_at)
       VALUES (?, ?, ?, ?, unixepoch() * 1000)`,
    )
    .run(chatId, tgUserId, senderName, content);
}

/** How many samples are buffered for a chat, and the timestamp of the oldest. */
export function sampleStats(chatId: number): { count: number; oldestAt: number | null } {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS count, MIN(created_at) AS oldest
       FROM chat_memory_sample WHERE chat_id = ?`,
    )
    .get(chatId) as { count: number; oldest: number | null };
  return { count: row.count, oldestAt: row.oldest };
}

/**
 * Take ownership of a chat's buffered samples: read them, then delete them in one
 * transaction so a concurrent flush can't process the same messages twice.
 */
export function claimSamples(chatId: number): MemorySample[] {
  const db = getDb();
  return db.transaction(() => {
    const rows = db
      .prepare(
        `SELECT tg_user_id, sender_name, content FROM chat_memory_sample
         WHERE chat_id = ? ORDER BY created_at ASC, id ASC`,
      )
      .all(chatId) as { tg_user_id: number; sender_name: string; content: string }[];
    if (rows.length > 0) {
      db.prepare('DELETE FROM chat_memory_sample WHERE chat_id = ?').run(chatId);
    }
    return rows.map((r) => ({
      tgUserId: r.tg_user_id,
      senderName: r.sender_name,
      content: r.content,
    }));
  })();
}

/** Chats with at least one sample older than `cutoff` (for the periodic flush). */
export function staleSampleChats(cutoff: number): number[] {
  const rows = getDb()
    .prepare(`SELECT DISTINCT chat_id FROM chat_memory_sample WHERE created_at <= ?`)
    .all(cutoff) as { chat_id: number }[];
  return rows.map((r) => r.chat_id);
}

// --- memory store -----------------------------------------------------------

interface ItemRow {
  id: number;
  chat_id: number;
  scope: MemoryScope;
  tg_user_id: number | null;
  subject: string;
  content: string;
  importance: number;
  reinforce: number;
  source: MemorySource;
  created_at: number;
  last_seen: number;
}

function mapRow(r: ItemRow): MemoryItem {
  return {
    id: r.id,
    chatId: r.chat_id,
    scope: r.scope,
    tgUserId: r.tg_user_id,
    subject: r.subject,
    content: r.content,
    importance: r.importance,
    reinforce: r.reinforce,
    source: r.source,
    createdAt: r.created_at,
    lastSeen: r.last_seen,
  };
}

/** Every memory item for a chat (unranked) — used for context selection and pruning. */
export function getAllItems(chatId: number): MemoryItem[] {
  const rows = getDb()
    .prepare(`SELECT * FROM chat_memory_item WHERE chat_id = ?`)
    .all(chatId) as ItemRow[];
  return rows.map(mapRow);
}

/** Insert a batch of extracted passive facts. Blank content is skipped. */
export function recordMemoryItems(chatId: number, drafts: MemoryDraft[]): void {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO chat_memory_item
       (chat_id, scope, tg_user_id, subject, content, importance, reinforce, source, created_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, 0, 'passive', unixepoch() * 1000, unixepoch() * 1000)`,
  );
  const run = db.transaction((items: MemoryDraft[]) => {
    for (const d of items) {
      const content = d.content.trim();
      if (!content) continue;
      const importance = Math.min(MAX_IMPORTANCE, Math.max(MIN_IMPORTANCE, d.importance));
      const tgUserId = d.scope === 'user' ? d.tgUserId : null;
      const subject = d.scope === 'user' ? d.subject.trim() : '';
      stmt.run(chatId, d.scope, tgUserId, subject, content, importance);
    }
  });
  run(drafts);
}

/**
 * Reinforce existing facts the extractor flagged as re-mentioned: bump the
 * reinforcement count, refresh last_seen (resetting decay) and nudge importance up
 * a notch (capped). Ignores ids that don't belong to the chat.
 */
export function reinforceItems(chatId: number, ids: number[]): void {
  if (ids.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(
    `UPDATE chat_memory_item
       SET reinforce = reinforce + 1,
           last_seen = unixepoch() * 1000,
           importance = MIN(?, importance + ?)
     WHERE id = ? AND chat_id = ?`,
  );
  const run = db.transaction((list: number[]) => {
    for (const id of list) stmt.run(MAX_IMPORTANCE, REINFORCE_IMPORTANCE_STEP, id, chatId);
  });
  run(ids);
}

/**
 * Insert an explicitly remembered, pinned fact (from the `remember` tool /
 * `/remember`). Defaults to chat-scope; pass scope='user' with a subject (and
 * optional tg_user_id) to attribute it to a person. Returns the new row id.
 */
export function insertPinned(
  chatId: number,
  content: string,
  opts: { scope?: MemoryScope; subject?: string; tgUserId?: number | null } = {},
): number {
  const scope = opts.scope ?? 'chat';
  const subject = scope === 'user' ? (opts.subject ?? '').trim() : '';
  const tgUserId = scope === 'user' ? (opts.tgUserId ?? null) : null;
  const res = getDb()
    .prepare(
      `INSERT INTO chat_memory_item
         (chat_id, scope, tg_user_id, subject, content, importance, reinforce, source, created_at, last_seen)
       VALUES (?, ?, ?, ?, ?, 3, 0, 'explicit', unixepoch() * 1000, unixepoch() * 1000)`,
    )
    .run(chatId, scope, tgUserId, subject, content.trim());
  return Number(res.lastInsertRowid);
}

/** Keep storage within `max` passive items; delete the lowest-weight overflow. */
export function pruneMemory(chatId: number, max: number, halfLifeDays: number): void {
  const items = getAllItems(chatId);
  const toDelete = selectForPrune(items, max, Date.now(), halfLifeDays);
  if (toDelete.length === 0) return;
  const db = getDb();
  const stmt = db.prepare('DELETE FROM chat_memory_item WHERE id = ?');
  db.transaction((ids: number[]) => {
    for (const id of ids) stmt.run(id);
  })(toDelete);
}

/** Build the tight working set to inject into the assistant context. */
export function getMemoryForContext(
  chatId: number,
  opts: {
    senderTgUserId: number;
    recentParticipantIds: number[];
    halfLifeDays: number;
    chatBudget: number;
    userBudget: number;
  },
): ContextSelection {
  return selectForContext(getAllItems(chatId), {
    now: Date.now(),
    halfLifeDays: opts.halfLifeDays,
    senderTgUserId: opts.senderTgUserId,
    recentParticipantIds: opts.recentParticipantIds,
    chatBudget: opts.chatBudget,
    userBudget: opts.userBudget,
  });
}

/** A memory item prepared for `/memory` display, pinned first then by weight. */
export interface DisplayItem {
  id: number;
  content: string;
  scope: MemoryScope;
  subject: string;
  pinned: boolean;
}

/**
 * All memory items ordered for display/editing: pinned (explicit) first, then by
 * effective weight. The returned order is stable so `/forget <N>` maps a shown
 * index back to a real row id.
 */
export function listMemoryItemsForDisplay(chatId: number, halfLifeDays: number): DisplayItem[] {
  const now = Date.now();
  return getAllItems(chatId)
    .sort((a, b) => {
      if (a.source !== b.source) return a.source === 'explicit' ? -1 : 1;
      return effectiveWeight(b, now, halfLifeDays) - effectiveWeight(a, now, halfLifeDays);
    })
    .map((i) => ({
      id: i.id,
      content: i.content,
      scope: i.scope,
      subject: i.subject,
      pinned: i.source === 'explicit',
    }));
}

/** Delete one item by id (scoped to the chat). Returns its content, or null. */
export function removeMemoryItem(chatId: number, id: number): string | null {
  const db = getDb();
  const row = db
    .prepare('SELECT content FROM chat_memory_item WHERE id = ? AND chat_id = ?')
    .get(id, chatId) as { content: string } | undefined;
  if (!row) return null;
  db.prepare('DELETE FROM chat_memory_item WHERE id = ? AND chat_id = ?').run(id, chatId);
  return row.content;
}

/** Wipe a chat's memory items and any buffered samples. */
export function clearMemoryItems(chatId: number): void {
  const db = getDb();
  db.prepare('DELETE FROM chat_memory_item WHERE chat_id = ?').run(chatId);
  db.prepare('DELETE FROM chat_memory_sample WHERE chat_id = ?').run(chatId);
}
