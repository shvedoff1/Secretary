import { getDb } from '../client.js';

/** A learned slang/distorted word for a chat. */
export interface LexiconEntry {
  term: string;
  gloss: string;
  frequency: number;
}

/** A {term, gloss} pair produced by the extractor before it is persisted. */
export interface LexiconTerm {
  term: string;
  gloss: string;
}

/** Buffer an incoming message for the next extraction batch. */
export function recordSample(chatId: number, content: string): void {
  getDb()
    .prepare(
      `INSERT INTO chat_lexicon_sample (chat_id, content, created_at)
       VALUES (?, ?, unixepoch() * 1000)`,
    )
    .run(chatId, content);
}

/** How many samples are buffered for a chat, and the timestamp of the oldest. */
export function sampleStats(chatId: number): { count: number; oldestAt: number | null } {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS count, MIN(created_at) AS oldest
       FROM chat_lexicon_sample WHERE chat_id = ?`,
    )
    .get(chatId) as { count: number; oldest: number | null };
  return { count: row.count, oldestAt: row.oldest };
}

/**
 * Take ownership of a chat's buffered samples: read them, then delete them in one
 * transaction so a concurrent flush can't process the same messages twice.
 */
export function claimSamples(chatId: number): string[] {
  const db = getDb();
  return db.transaction(() => {
    const rows = db
      .prepare(
        `SELECT content FROM chat_lexicon_sample
         WHERE chat_id = ? ORDER BY created_at ASC, id ASC`,
      )
      .all(chatId) as { content: string }[];
    if (rows.length > 0) {
      db.prepare('DELETE FROM chat_lexicon_sample WHERE chat_id = ?').run(chatId);
    }
    return rows.map((r) => r.content);
  })();
}

/** Chats with at least one sample older than `cutoff` (for the periodic flush). */
export function staleSampleChats(cutoff: number): number[] {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT chat_id FROM chat_lexicon_sample WHERE created_at <= ?`,
    )
    .all(cutoff) as { chat_id: number }[];
  return rows.map((r) => r.chat_id);
}

/**
 * Merge a batch of extracted terms into a chat's lexicon. Terms are normalized to
 * trimmed lower-case for de-duplication; re-seeing one bumps its frequency and
 * refreshes the gloss (a non-empty new gloss wins) and last_seen.
 */
export function recordTerms(chatId: number, terms: LexiconTerm[]): void {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO chat_lexicon (chat_id, term, gloss, frequency, first_seen, last_seen)
     VALUES (?, ?, ?, 1, unixepoch() * 1000, unixepoch() * 1000)
     ON CONFLICT(chat_id, term) DO UPDATE SET
       frequency = frequency + 1,
       gloss = CASE WHEN excluded.gloss <> '' THEN excluded.gloss ELSE chat_lexicon.gloss END,
       last_seen = excluded.last_seen`,
  );
  const run = db.transaction((items: LexiconTerm[]) => {
    for (const item of items) {
      const term = item.term.trim().toLowerCase();
      if (!term) continue;
      stmt.run(chatId, term, (item.gloss ?? '').trim());
    }
  });
  run(terms);
}

/** Learned lexicon for a chat, most-used first. */
export function getLexicon(chatId: number, limit?: number): LexiconEntry[] {
  const sql =
    `SELECT term, gloss, frequency FROM chat_lexicon
     WHERE chat_id = ? ORDER BY frequency DESC, last_seen DESC, term ASC` +
    (limit !== undefined ? ' LIMIT ?' : '');
  const args = limit !== undefined ? [chatId, limit] : [chatId];
  const rows = getDb().prepare(sql).all(...args) as {
    term: string;
    gloss: string;
    frequency: number;
  }[];
  return rows.map((r) => ({ term: r.term, gloss: r.gloss, frequency: r.frequency }));
}

/**
 * Correct the stored meaning (gloss) of an existing lexicon term — the
 * "поменяй значение у X на Y" flow. Matches the term case-insensitively; if
 * there's no exact match, falls back to a UNIQUE containment match (so «типа»
 * finds a stored «тип» and vice-versa) to be forgiving about the exact form the
 * user typed. Returns whether a row was updated and the actual stored term that
 * matched (so the caller can confirm using the chat's own spelling). Never
 * creates a new term — this edits meanings, it doesn't teach new words.
 */
export function setGloss(
  chatId: number,
  term: string,
  gloss: string,
): { updated: boolean; term: string } {
  const t = term.trim().toLowerCase();
  const g = gloss.trim();
  if (!t) return { updated: false, term };

  const db = getDb();
  const apply = (stored: string): { updated: boolean; term: string } => {
    db.prepare(
      `UPDATE chat_lexicon SET gloss = ?, last_seen = unixepoch() * 1000
       WHERE chat_id = ? AND term = ?`,
    ).run(g, chatId, stored);
    return { updated: true, term: stored };
  };

  const exact = db
    .prepare(`SELECT term FROM chat_lexicon WHERE chat_id = ? AND term = ?`)
    .get(chatId, t) as { term: string } | undefined;
  if (exact) return apply(exact.term);

  // Forgiving fallback: a single term where one contains the other.
  const near = db
    .prepare(
      `SELECT term FROM chat_lexicon
       WHERE chat_id = ? AND (instr(term, ?) > 0 OR instr(?, term) > 0)`,
    )
    .all(chatId, t, t) as { term: string }[];
  if (near.length === 1) return apply(near[0]!.term);

  return { updated: false, term: t };
}

/** Wipe a chat's learned lexicon and any buffered samples. */
export function clearLexicon(chatId: number): void {
  const db = getDb();
  db.prepare('DELETE FROM chat_lexicon WHERE chat_id = ?').run(chatId);
  db.prepare('DELETE FROM chat_lexicon_sample WHERE chat_id = ?').run(chatId);
}
