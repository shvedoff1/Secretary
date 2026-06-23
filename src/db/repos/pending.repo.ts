import { getDb } from '../client.js';
import type { ExpenseDraft } from '../../core/types.js';
import { shortId } from '../../util/ids.js';

export type PendingStatus = 'awaiting' | 'confirmed' | 'cancelled' | 'expired';
export type PendingSource = 'text' | 'photo' | 'voice';

export interface PendingRow {
  id: string;
  chat_id: number;
  tg_user_id: number;
  draft_json: string;
  source: PendingSource;
  status: PendingStatus;
  created_at: number;
}

export interface Pending {
  id: string;
  chatId: number;
  tgUserId: number;
  draft: ExpenseDraft;
  source: PendingSource;
  status: PendingStatus;
  createdAt: number;
}

function hydrate(row: PendingRow): Pending {
  return {
    id: row.id,
    chatId: row.chat_id,
    tgUserId: row.tg_user_id,
    draft: JSON.parse(row.draft_json) as ExpenseDraft,
    source: row.source,
    status: row.status,
    createdAt: row.created_at,
  };
}

export function createPending(args: {
  chatId: number;
  tgUserId: number;
  draft: ExpenseDraft;
  source: PendingSource;
}): Pending {
  const id = shortId();
  getDb()
    .prepare(
      `INSERT INTO pending_expense (id, chat_id, tg_user_id, draft_json, source, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'awaiting', unixepoch() * 1000)`,
    )
    .run(
      id,
      args.chatId,
      args.tgUserId,
      JSON.stringify(args.draft),
      args.source,
    );
  return getPending(id)!;
}

export function getPending(id: string): Pending | undefined {
  const row = getDb()
    .prepare('SELECT * FROM pending_expense WHERE id = ?')
    .get(id) as PendingRow | undefined;
  return row ? hydrate(row) : undefined;
}

export function updateDraft(id: string, draft: ExpenseDraft): void {
  getDb()
    .prepare('UPDATE pending_expense SET draft_json = ? WHERE id = ?')
    .run(JSON.stringify(draft), id);
}

/**
 * Atomically move an awaiting pending to `confirmed`. Returns the row only if
 * THIS call performed the transition — a concurrent/duplicate tap returns
 * undefined, preventing double submission.
 */
export function claimForConfirm(id: string): Pending | undefined {
  const db = getDb();
  const txn = db.transaction((pid: string): Pending | undefined => {
    const info = db
      .prepare(
        "UPDATE pending_expense SET status = 'confirmed' WHERE id = ? AND status = 'awaiting'",
      )
      .run(pid);
    if (info.changes === 0) return undefined;
    return getPending(pid);
  });
  return txn(id);
}

export function setStatus(id: string, status: PendingStatus): void {
  getDb()
    .prepare('UPDATE pending_expense SET status = ? WHERE id = ?')
    .run(status, id);
}

/** Mark old awaiting previews as expired. Returns the number swept. */
export function expireOld(ttlMinutes: number): number {
  const cutoff = Date.now() - ttlMinutes * 60_000;
  return getDb()
    .prepare(
      "UPDATE pending_expense SET status = 'expired' WHERE status = 'awaiting' AND created_at < ?",
    )
    .run(cutoff).changes;
}
