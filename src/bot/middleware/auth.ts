import type { Context, NextFunction } from 'grammy';
import { isApproved } from '../../db/repos/users.repo.js';
import { getChatConfig } from '../../db/repos/chatConfig.repo.js';

const EXEMPT = /^\/(start|help|request)(@\w+)?\b/;

/**
 * Default-deny gate. Only approved users pass; everyone else is blocked from all
 * handlers except /start, /help, /request. Keeps the bot from being abused.
 *
 * Exception: a *configured* group (an admin already connected it via /group) is
 * a trusted shared space, so every participant there can use the bot. The gate
 * still protects DMs and groups that haven't been set up.
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

  // Trusted shared space: any participant of a configured group passes.
  if (ctx.chat && ctx.chat.type !== 'private') {
    const chatCfg = getChatConfig(ctx.chat.id);
    if (chatCfg?.provider_group_id) {
      await next();
      return;
    }
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
