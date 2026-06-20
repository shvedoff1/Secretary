// Process-local map: a bot preview message the user can reply to in order to
// reword the expense, keyed by `${chatId}:${messageId}` → pendingId.
// In-memory is fine for a single-instance long-polling bot.
const targets = new Map<string, string>();

function key(chatId: number, messageId: number): string {
  return `${chatId}:${messageId}`;
}

export function setEditTarget(
  chatId: number,
  messageId: number,
  pendingId: string,
): void {
  targets.set(key(chatId, messageId), pendingId);
}

export function getEditTarget(
  chatId: number,
  messageId: number,
): string | undefined {
  return targets.get(key(chatId, messageId));
}

export function clearEditTarget(chatId: number, messageId: number): void {
  targets.delete(key(chatId, messageId));
}
