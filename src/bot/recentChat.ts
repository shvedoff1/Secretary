/**
 * In-memory, per-chat ring buffer of recent chatter. Shared by two consumers:
 *   • the spontaneous chime (`flows/chime.ts`) — to continue a lull by context;
 *   • the scheduler (`scheduler.ts`) — so a scheduled "vibe" task (a humour task)
 *     can riff on what was just said instead of firing context-blind.
 *
 * Kept out of `chime.ts` so the scheduler can read the buffer without importing
 * the whole bot/assist chain. Best-effort and process-local: it is empty after a
 * restart or for a chat that has been quiet, and callers must tolerate that.
 */

/** How many recent lines of chatter to keep per chat. */
export const RECENT_MAX = 12;

const buffers = new Map<number, { name: string; text: string }[]>();

/**
 * Record a chat message into the rolling buffer (newest last, capped at
 * {@link RECENT_MAX}). Called for every text message so any later consumer has
 * the latest chatter to work from.
 */
export function recordChatMessage(chatId: number, name: string, text: string): void {
  let buf = buffers.get(chatId);
  if (!buf) {
    buf = [];
    buffers.set(chatId, buf);
  }
  buf.push({ name, text });
  if (buf.length > RECENT_MAX) buf.splice(0, buf.length - RECENT_MAX);
}

/** Recent chatter for a chat, oldest first. Empty when nothing is buffered. */
export function getRecentChat(chatId: number): { name: string; text: string }[] {
  return buffers.get(chatId)?.slice() ?? [];
}

/** Test helper: drop all buffered chatter. */
export function clearRecentChat(): void {
  buffers.clear();
}
