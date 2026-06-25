import { getDb } from '../client.js';

/** A learned expense-trigger word/phrase for a chat. */
export interface ExpenseTerm {
  term: string;
  createdAt: number;
}

/** Normalize a term for storage/matching: trimmed, collapsed spaces, lower-case. */
function normalize(term: string): string {
  return term.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Add trigger words/phrases to a chat's expense dictionary. Terms are normalized
 * (trimmed lower-case) for de-duplication; re-adding one is a no-op. Returns the
 * normalized terms that were actually stored (non-empty, deduped within the call).
 */
export function addExpenseTerms(
  chatId: number,
  terms: string[],
  tgUserId: number | null,
): string[] {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO chat_expense_term (chat_id, term, tg_user_id, created_at)
     VALUES (?, ?, ?, unixepoch() * 1000)
     ON CONFLICT(chat_id, term) DO NOTHING`,
  );
  const added: string[] = [];
  const seen = new Set<string>();
  const run = db.transaction((items: string[]) => {
    for (const raw of items) {
      const term = normalize(raw);
      if (!term || seen.has(term)) continue;
      seen.add(term);
      // changes === 0 when ON CONFLICT skipped an already-known term.
      if (stmt.run(chatId, term, tgUserId).changes > 0) added.push(term);
    }
  });
  run(terms);
  return added;
}

/** All learned expense trigger terms for a chat, newest first. */
export function listExpenseTerms(chatId: number): ExpenseTerm[] {
  const rows = getDb()
    .prepare(
      `SELECT term, created_at FROM chat_expense_term
       WHERE chat_id = ? ORDER BY created_at DESC, term ASC`,
    )
    .all(chatId) as { term: string; created_at: number }[];
  return rows.map((r) => ({ term: r.term, createdAt: r.created_at }));
}

/** Just the term strings for a chat (used by the expense-detection heuristic). */
export function getExpenseTerms(chatId: number): string[] {
  const rows = getDb()
    .prepare('SELECT term FROM chat_expense_term WHERE chat_id = ?')
    .all(chatId) as { term: string }[];
  return rows.map((r) => r.term);
}

/** Wipe a chat's learned expense dictionary. */
export function clearExpenseTerms(chatId: number): void {
  getDb().prepare('DELETE FROM chat_expense_term WHERE chat_id = ?').run(chatId);
}
