import { getDb } from '../client.js';

/**
 * One profile card (see migration 028): the bot's own running portrait of the
 * chat (subject '') or of one person (subject = their name, NOCASE-unique so
 * «гоша» and «Гоша» are the same card). Cards are DERIVED — rewritten by the
 * refresh pass at episode close from the previous card + new episode notes +
 * current top facts — so wiping them loses nothing that can't be regenerated.
 */
export interface ProfileCard {
  id: number;
  chatId: number;
  /** '' for the chat card, else the person's name as the chat writes it. */
  subject: string;
  content: string;
  updatedAt: number;
}

interface Row {
  id: number;
  chat_id: number;
  subject: string;
  content: string;
  updated_at: number;
}

function mapRow(r: Row): ProfileCard {
  return {
    id: r.id,
    chatId: r.chat_id,
    subject: r.subject,
    content: r.content,
    updatedAt: r.updated_at,
  };
}

/**
 * Create or overwrite the card for a subject. Subject matching is
 * case-insensitive («гоша» updates the «Гоша» card) — done in JS, because
 * SQLite's NOCASE/lower() are ASCII-only and this bot's subjects are Cyrillic.
 * A matched card keeps its stored spelling; only the content and time move.
 */
export function upsertProfile(chatId: number, subject: string, content: string): void {
  const db = getDb();
  const want = subject.trim();
  const key = want.toLowerCase();
  const existing = (
    db.prepare('SELECT id, subject FROM chat_profile WHERE chat_id = ?').all(chatId) as {
      id: number;
      subject: string;
    }[]
  ).find((r) => r.subject.toLowerCase() === key);
  if (existing) {
    db.prepare(
      `UPDATE chat_profile SET content = ?, updated_at = unixepoch() * 1000 WHERE id = ?`,
    ).run(content.trim(), existing.id);
    return;
  }
  db.prepare(
    `INSERT INTO chat_profile (chat_id, subject, content, updated_at)
     VALUES (?, ?, ?, unixepoch() * 1000)`,
  ).run(chatId, want, content.trim());
}

/** Every card for a chat: the chat card first, then people by freshest update. */
export function listProfiles(chatId: number): ProfileCard[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM chat_profile WHERE chat_id = ?
       ORDER BY (subject = '') DESC, updated_at DESC, id ASC`,
    )
    .all(chatId) as Row[];
  return rows.map(mapRow);
}

/** How many cards the chat holds. */
export function profileCount(chatId: number): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM chat_profile WHERE chat_id = ?')
    .get(chatId) as { n: number };
  return row.n;
}

/** Wipe a chat's cards (admin /profile <chatId> clear); rebuilt at the next close. */
export function clearProfiles(chatId: number): void {
  getDb().prepare('DELETE FROM chat_profile WHERE chat_id = ?').run(chatId);
}
