import { getDb } from '../client.js';

export function getMemory(chatId: number): string {
  const row = getDb()
    .prepare('SELECT content FROM chat_memory WHERE chat_id = ?')
    .get(chatId) as { content: string } | undefined;
  return row?.content ?? '';
}

export function setMemory(chatId: number, content: string): void {
  getDb()
    .prepare(
      `INSERT INTO chat_memory (chat_id, content, updated_at)
       VALUES (?, ?, unixepoch() * 1000)
       ON CONFLICT(chat_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
    )
    .run(chatId, content);
}

/** Append a bullet line to the chat's memory document. */
export function appendMemory(chatId: number, note: string): string {
  const existing = getMemory(chatId).trimEnd();
  const line = `- ${note.trim()}`;
  const next = existing ? `${existing}\n${line}` : line;
  setMemory(chatId, next);
  return next;
}

export function clearMemory(chatId: number): void {
  setMemory(chatId, '');
}
