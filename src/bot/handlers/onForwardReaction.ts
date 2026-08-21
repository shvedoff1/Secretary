import type { Context } from 'grammy';
import { logger } from '../../logger.js';
import { runAndRespond } from '../flows/assist.js';
import { FORWARD_MARK, isBufferedMessage } from '../forwardBuffer.js';

/**
 * The forward batch's "button": every buffered message carries the bot's
 * FORWARD_MARK reaction, and a user tapping that same emoji on any of them says
 * «обработай пачку сейчас» without typing anything — which is also how a single
 * forwarded voice note gets its answer. Telegram sends the tap as a
 * `message_reaction` update (requested in allowed_updates in index.ts; in
 * groups Telegram only delivers these when the bot is an administrator).
 *
 * Only an ADDED FORWARD_MARK on a message that is actually sitting in the batch
 * triggers — any other emoji, a reaction being removed, or a tap on something
 * long consumed/expired is ignored, so ordinary reaction chatter can't fire an
 * LLM run. Bots' own reactions never arrive as updates, so the bot's mark can't
 * trigger itself.
 */
export async function onForwardReaction(ctx: Context): Promise<void> {
  const upd = ctx.messageReaction;
  if (!upd || !ctx.chat || !ctx.from) return;

  const had = upd.old_reaction.some((r) => r.type === 'emoji' && r.emoji === FORWARD_MARK);
  const has = upd.new_reaction.some((r) => r.type === 'emoji' && r.emoji === FORWARD_MARK);
  if (had || !has) return; // not a fresh FORWARD_MARK tap

  if (!isBufferedMessage(ctx.chat.id, upd.message_id)) return; // consumed/expired/foreign

  logger.info({ chatId: ctx.chat.id, messageId: upd.message_id }, 'forward batch tap');

  // No typed request exists, so the turn is just the batch (runAndRespond drains
  // and prepends it) plus a neutral instruction. The model decides what "process"
  // means: answer a question the pack contains, otherwise summarize — and the
  // chat's standing rules («пересланные пересказывай кратко») apply as always.
  await runAndRespond(ctx, {
    userContent:
      'Пользователь нажал на реакцию-кнопку у пересланных сообщений — текстовой просьбы нет. ' +
      'Обработай пересланную пачку выше по смыслу: если там вопрос или просьба, на которую ты ' +
      'можешь ответить — ответь; иначе сделай короткое саммари главного.',
    addressed: true,
    source: 'text',
    historyText: '[нажата кнопка обработки пересланного]',
    // ctx.message is undefined on a reaction update — there is nothing to hang
    // the 👀 on (the typing indicator still shows progress).
    manageReaction: false,
    includeForwardBatch: true,
  });
}
