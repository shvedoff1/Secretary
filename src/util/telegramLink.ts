// Pure: links back to Telegram messages (used by recaps to cite their sources).

/**
 * A t.me link to a message, or null where Telegram has none. Only SUPERGROUPS
 * (ids -100…) have private `t.me/c/<id>/<msg>` links — basic groups and DMs
 * don't, and a fabricated link there would just 404. A topic message gets the
 * thread-scoped form so the link opens inside the right thread. Links work only
 * for members of the chat, which is exactly who reads the recap.
 */
export function messageLink(
  chatId: number,
  messageId: number | null | undefined,
  threadId?: number | null,
): string | null {
  if (messageId == null || messageId <= 0) return null;
  const s = String(chatId);
  if (!s.startsWith('-100') || s.length <= 4) return null;
  const internal = s.slice(4);
  return threadId != null && threadId > 0
    ? `https://t.me/c/${internal}/${threadId}/${messageId}`
    : `https://t.me/c/${internal}/${messageId}`;
}
