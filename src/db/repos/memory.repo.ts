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

/** Non-blank memory lines, as stored (bullet prefix kept). */
function memoryLines(chatId: number): string[] {
  return getMemory(chatId)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Memory entries for display, one per line with the bullet prefix stripped. */
export function listMemoryLines(chatId: number): string[] {
  return memoryLines(chatId).map((l) => l.replace(/^[-*]\s+/, ''));
}

/**
 * Delete the 1-based Nth memory entry (matching `listMemoryLines` order). Returns
 * the removed text (bullet stripped), or null if the index is out of range. Used
 * to prune a single stray note without wiping the whole memory.
 */
export function removeMemoryLine(chatId: number, index: number): string | null {
  const lines = memoryLines(chatId);
  if (index < 1 || index > lines.length) return null;
  const [removed] = lines.splice(index - 1, 1);
  setMemory(chatId, lines.join('\n'));
  return (removed ?? '').replace(/^[-*]\s+/, '');
}
