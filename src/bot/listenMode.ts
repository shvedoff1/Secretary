import type { Context } from 'grammy';
import { isListenOnly } from '../db/repos/chatSettings.repo.js';

/**
 * Is this a LISTEN-ONLY group (`/listen <chatId> on`)? There the bot is a silent
 * recorder: it logs everything, and speaks ONLY when explicitly called — an
 * @mention or a reply to one of its messages (`isAddressed`). Everything softer is
 * ignored on purpose: its name said in a voice note or typed in a message
 * («бот, глянь»), a photo caption naming it, an expense-looking line, a forward;
 * and it never chimes in or drops random reactions. In a work chat people say
 * «бот» about the product all day — only an explicit ping is a request.
 * DMs are never listen-only.
 */
export function isQuietChat(ctx: Context): boolean {
  const chat = ctx.chat;
  if (!chat || chat.type === 'private') return false;
  return isListenOnly(chat.id);
}
