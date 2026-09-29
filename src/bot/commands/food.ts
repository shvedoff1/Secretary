import type { Context } from 'grammy';
import { loadConfig } from '../../config.js';
import { clearFoodGoal, removeFoodEntries, setFoodGoal } from '../../db/repos/food.repo.js';
import {
  foodTimezone,
  localToday,
  renderFoodReport,
  shiftDays,
} from '../../food/handler.js';
import { fmtNum } from '../../food/nutrition.js';
import { replyLong } from '../../util/telegramText.js';

export type FoodCommand =
  | { kind: 'day'; offset: number }
  | { kind: 'period'; days: number }
  | { kind: 'goal'; kcal: number; protein: number | null; fat: number | null; carbs: number | null }
  | { kind: 'goal_off' }
  | { kind: 'del'; ids: number[] }
  | { kind: 'help' };

const WEEK = new Set(['week', 'неделя', 'неделю', '7']);
const MONTH = new Set(['month', 'месяц', '30']);

/**
 * Parse `/food` arguments. Pure, so the grammar is unit-tested:
 * (none)/today · yesterday/вчера · week · month · <N>d · goal <kcal> [Б Ж У] ·
 * goal off · del <id> [id…].
 */
export function parseFoodArgs(raw: string): FoodCommand {
  const parts = raw.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const [head = '', ...rest] = parts;
  if (head === '' || head === 'today' || head === 'сегодня') return { kind: 'day', offset: 0 };
  if (head === 'yesterday' || head === 'вчера') return { kind: 'day', offset: -1 };
  if (WEEK.has(head)) return { kind: 'period', days: 7 };
  if (MONTH.has(head)) return { kind: 'period', days: 30 };
  const nd = /^(\d{1,2})(d|д|дн|дней)?$/.exec(head);
  if (nd && Number(nd[1]) >= 1) {
    const n = Math.min(Number(nd[1]), 92);
    return n === 1 ? { kind: 'day', offset: 0 } : { kind: 'period', days: n };
  }
  if (head === 'goal' || head === 'цель' || head === 'норма') {
    if (rest[0] === 'off' || rest[0] === 'нет' || rest[0] === 'сброс' || rest[0] === '0') {
      return { kind: 'goal_off' };
    }
    const nums = rest.map((x) => Number(x.replace(',', '.')));
    if (nums.length === 0 || nums.some((x) => !Number.isFinite(x) || x < 0) || nums[0]! <= 0) {
      return { kind: 'help' };
    }
    return {
      kind: 'goal',
      kcal: Math.round(nums[0]!),
      protein: nums[1] ?? null,
      fat: nums[2] ?? null,
      carbs: nums[3] ?? null,
    };
  }
  if (head === 'del' || head === 'rm' || head === 'удали' || head === '-') {
    const ids = rest.map((x) => Number(x.replace(/^#/, ''))).filter((x) => Number.isInteger(x) && x > 0);
    return ids.length > 0 ? { kind: 'del', ids } : { kind: 'help' };
  }
  return { kind: 'help' };
}

const HELP =
  'Дневник еды — просто скажи или покажи, что съел: «съел гречку с курицей», ' +
  'голосовое или фото тарелки/этикетки. Я прикину калории и БЖУ, если надо — уточню одно.\n\n' +
  '/food — сегодня · /food вчера · /food week · /food month\n' +
  '/food goal 2000 [Б Ж У] — дневная цель · /food goal off\n' +
  '/food del <id> — удалить запись';

/**
 * `/food` — the sender's calorie diary in this chat, zero LLM tokens: today's
 * log, a period's statistics, the daily goal, deleting a wrong entry. Logging
 * itself is conversational (voice / photo / words → the log_food tool).
 */
export async function cmdFood(ctx: Context): Promise<void> {
  if (!ctx.chat || !ctx.from) return;
  if (!loadConfig().ENABLE_FOOD) {
    await ctx.reply('Дневник еды выключен на этом боте.');
    return;
  }
  const chatId = ctx.chat.id;
  const userId = ctx.from.id;
  const cmd = parseFoodArgs((ctx.match as string | undefined) ?? '');
  const today = localToday(foodTimezone(chatId));

  switch (cmd.kind) {
    case 'day': {
      const d = shiftDays(today, cmd.offset);
      await replyLong(ctx, renderFoodReport(chatId, userId, d, d, today));
      return;
    }
    case 'period':
      await replyLong(
        ctx,
        renderFoodReport(chatId, userId, shiftDays(today, -(cmd.days - 1)), today, today),
      );
      return;
    case 'goal':
      setFoodGoal(chatId, userId, {
        kcal: cmd.kcal,
        protein: cmd.protein,
        fat: cmd.fat,
        carbs: cmd.carbs,
      });
      await ctx.reply(
        `🎯 Цель: ${fmtNum(cmd.kcal)} ккал в день` +
          (cmd.protein !== null
            ? ` (Б ${fmtNum(cmd.protein)}${cmd.fat !== null ? ` · Ж ${fmtNum(cmd.fat)}` : ''}${cmd.carbs !== null ? ` · У ${fmtNum(cmd.carbs)}` : ''} г)`
            : '') +
          '. Итог дня — /food',
      );
      return;
    case 'goal_off':
      await ctx.reply(clearFoodGoal(chatId, userId) ? 'Цель снята.' : 'Цели и так не было.');
      return;
    case 'del': {
      const removed = removeFoodEntries(chatId, userId, cmd.ids);
      await ctx.reply(
        removed.length > 0
          ? `🗑️ Удалил: ${removed.map((e) => `#${e.id} ${e.name}`).join(', ')}. Итог — /food`
          : 'Таких записей в твоём дневнике нет.',
      );
      return;
    }
    default:
      await ctx.reply(HELP);
  }
}
