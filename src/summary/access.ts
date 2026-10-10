// Who may read which chat's log — the gate behind «что там в рабочем чате?»
// asked from the DM.
//
// The rule is Telegram's own: you may read a chat's log only if you are a member
// of that chat right now. The log holds exactly what members already saw, so a
// member reading it from the DM learns nothing new; anyone else (someone who left,
// was never in it, or just guessed a chat id) gets nothing. Membership comes from
// getChatMember — authoritative, and it handles people who left since posting.
// Cached briefly: a recap asks once per tool call, and a «/listen» work chat can
// be asked about a lot.

import type { Api } from 'grammy';
import { logger } from '../logger.js';

const TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { ok: boolean; at: number }>();

/** getChatMember statuses that mean "is in the chat and can see its messages". */
export function isMemberStatus(member: { status: string; is_member?: boolean }): boolean {
  if (member.status === 'creator' || member.status === 'administrator' || member.status === 'member') {
    return true;
  }
  // A restricted user is still in the chat iff is_member.
  return member.status === 'restricted' && member.is_member === true;
}

export type ChatReadCheck = (chatId: number) => Promise<boolean>;

/** A checker bound to one asker. Errors (bot not in the chat, …) read as "no". */
export function makeChatReadCheck(api: Pick<Api, 'getChatMember'>, tgUserId: number): ChatReadCheck {
  return async (chatId) => {
    if (chatId === tgUserId) return true; // their own DM
    const key = `${chatId}:${tgUserId}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.ok;
    let ok = false;
    try {
      ok = isMemberStatus(await api.getChatMember(chatId, tgUserId));
    } catch (err) {
      logger.warn({ err, chatId, tgUserId }, 'getChatMember failed — denying log read');
    }
    cache.set(key, { ok, at: Date.now() });
    return ok;
  };
}

/** Test helper. */
export function resetChatReadCache(): void {
  cache.clear();
}

/**
 * The context-block line a DM gets: which work chats the user can ask about from
 * here. DB-only (chats where they have posted, from the log) — no Telegram calls
 * per turn; membership is checked on the actual read. null when there are none.
 */
export function otherChatsLine(chats: readonly { chatId: number; title: string | null }[]): string | null {
  if (chats.length === 0) return null;
  const list = chats.map((c) => `«${c.title ?? `чат ${c.chatId}`}» (id ${c.chatId})`).join(', ');
  return `Chats you can ask about from here (summarize_chat with chat=<title>; access is checked): ${list}.`;
}
