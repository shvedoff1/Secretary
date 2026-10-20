import type { Context } from 'grammy';
import { foodAllowedIn } from '../../core/chatScope.js';
import { getDayTypeById, setDayKind } from '../../db/repos/food.repo.js';
import { DAY_TYPE_CALLBACK_RE } from '../../food/dayTypeKeyboard.js';
import { foodTimezone, localToday, renderFoodReport } from '../../food/handler.js';
import { logger } from '../../logger.js';
import { sendRichMarkdown } from '../../util/richMessage.js';

/**
 * A tap on a «какой сегодня день?» button. The diary lives in the DM only, where
 * the chat id IS the person's id — so the tapper is the diary's owner by
 * construction and nobody can set someone else's day type. The buttons are
 * removed after the pick and the day's table is re-sent against the new goal.
 */
export async function handleDayTypeCallback(ctx: Context): Promise<void> {
  const m = DAY_TYPE_CALLBACK_RE.exec(ctx.callbackQuery?.data ?? '');
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;
  if (!m || chatId === undefined || userId === undefined || !foodAllowedIn(chatId) || chatId !== userId) {
    await ctx.answerCallbackQuery();
    return;
  }
  const date = m[1]!;
  const typeId = Number(m[2]);
  let label = 'Обычный';
  if (typeId !== 0) {
    const type = getDayTypeById(chatId, userId, typeId);
    if (!type) {
      await ctx.answerCallbackQuery({ text: 'Такого типа дня уже нет — /food types' });
      return;
    }
    label = type.name;
  }
  setDayKind(chatId, userId, date, typeId === 0 ? null : typeId);
  await ctx.answerCallbackQuery({ text: `День: ${label}` });
  // Drop the buttons from the message they were on (best-effort — an old
  // message may no longer be editable).
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: undefined });
  } catch (err) {
    logger.debug({ err }, 'could not clear day-type buttons');
  }
  const today = localToday(foodTimezone(chatId));
  await sendRichMarkdown(ctx.api, chatId, renderFoodReport(chatId, userId, date, date, today));
}
