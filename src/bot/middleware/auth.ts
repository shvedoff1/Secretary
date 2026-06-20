import type { Context, NextFunction } from 'grammy';
import { isApproved } from '../../db/repos/users.repo.js';

const EXEMPT = /^\/(start|help|request)(@\w+)?\b/;

/**
 * Default-deny gate. Only approved users pass; everyone else is blocked from all
 * handlers except /start, /help, /request. Keeps the bot from being abused.
 */
export async function authGate(ctx: Context, next: NextFunction): Promise<void> {
  const uid = ctx.from?.id;
  if (!uid) return; // channel posts, etc.

  const text = ctx.message?.text ?? '';
  if (EXEMPT.test(text)) {
    await next();
    return;
  }

  if (isApproved(uid)) {
    await next();
    return;
  }

  // Block silently in groups; nudge in private chats.
  if (ctx.chat?.type === 'private') {
    await ctx.reply(
      'Доступ закрыт. Отправьте /request, чтобы запросить доступ у администратора.',
    );
  } else if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery({ text: 'Нет доступа.' });
  }
}
