import type { Context } from 'grammy';

const EXPENSE_KEYWORDS =
  /(потрат|заплат|оплат|скинул|должен|долж|чек|счет|счёт|за\s|spent|paid|bought|cost|bill|check|lunch|dinner|breakfast|taxi|такси|обед|ужин|завтрак|груш|product|groсer|store|shop|кафе|cafe|restaurant|рестора)/i;

/** Heuristic: does this text look like it reports a spend? Requires a number. */
export function looksLikeExpense(text: string): boolean {
  if (!/\d/.test(text)) return false;
  return EXPENSE_KEYWORDS.test(text);
}

/** Was the bot directly addressed (DM, @mention, or reply to its message)? */
export function isAddressed(ctx: Context): boolean {
  if (ctx.chat?.type === 'private') return true;

  const msg = ctx.message;
  if (!msg) return false;

  const me = ctx.me;
  if (msg.reply_to_message?.from?.id === me.id) return true;

  const text = msg.text ?? msg.caption ?? '';
  const entities = msg.entities ?? msg.caption_entities ?? [];
  for (const e of entities) {
    if (e.type === 'mention') {
      const mention = text.slice(e.offset, e.offset + e.length);
      if (mention.toLowerCase() === `@${me.username.toLowerCase()}`) return true;
    }
    if (e.type === 'text_mention' && e.user?.id === me.id) return true;
  }
  return false;
}

export type RouteDecision = 'process' | 'auto-expense' | 'ignore';

/**
 * Decide how to handle an incoming text/caption message in a configured chat.
 * - DM / addressed → process (the assistant decides expense vs chat).
 * - Group, not addressed, looks like a spend → auto-expense (act only if the
 *   assistant returns an expense; otherwise stay silent).
 * - Otherwise ignore.
 */
export function routeMessage(ctx: Context, text: string): RouteDecision {
  if (isAddressed(ctx)) return 'process';
  if (looksLikeExpense(text)) return 'auto-expense';
  return 'ignore';
}
