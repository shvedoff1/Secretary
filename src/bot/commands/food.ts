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
import { threadIdOf } from '../threads.js';
import { sendRichMarkdown } from '../../util/richMessage.js';

export type FoodCommand =
  | { kind: 'day'; offset: number }
  | { kind: 'period'; days: number }
  | { kind: 'range'; from: string; to: string }
  | { kind: 'goal'; kcal: number; protein: number | null; fat: number | null; carbs: number | null }
  | { kind: 'goal_off' }
  | { kind: 'del'; ids: number[] }
  | { kind: 'help' };

const WEEK = new Set(['week', 'неделя', 'неделю', '7']);
const MONTH = new Set(['month', 'месяц', '30']);

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * One date as the user types it: «28.09», «28.09.26», «28.09.2026», «28/09»,
 * «2026-09-28». A date without a year is the LATEST such day not after today
 * («/food 28.12» typed in January means last December, not next one). Invalid
 * calendar dates (31.02) are null. Pure, so it is unit-tested.
 */
export function parseFoodDate(token: string, today: string): string | null {
  const t = token.trim();
  let y: number | null;
  let m: number;
  let d: number;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  const dm = /^(\d{1,2})[./](\d{1,2})(?:[./](\d{2}|\d{4}))?$/.exec(t);
  if (iso) {
    [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  } else if (dm) {
    d = Number(dm[1]);
    m = Number(dm[2]);
    y = dm[3] ? Number(dm[3].length === 2 ? `20${dm[3]}` : dm[3]) : null;
  } else {
    return null;
  }
  const build = (yy: number): string | null => {
    const dt = new Date(Date.UTC(yy, m - 1, d));
    if (dt.getUTCFullYear() !== yy || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
    return `${yy}-${pad2(m)}-${pad2(d)}`;
  };
  if (y !== null) return build(y);
  const thisYear = Number(today.slice(0, 4));
  const candidate = build(thisYear);
  if (candidate && candidate <= today) return candidate;
  return build(thisYear - 1);
}

/**
 * A custom period: «01.09-15.09», «01.09 - 15.09», «01.09 15.09», «с 01.09 по
 * 15.09», «2026-09-01 2026-09-15», or a single date («28.09» → that day). The
 * order of the two ends doesn't matter. Null when the text isn't dates.
 */
export function parseFoodRange(text: string, today: string): { from: string; to: string } | null {
  const DATE = /\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?/g;
  const tokens = text.match(DATE) ?? [];
  // Everything that is not a date must be a separator — otherwise this is not
  // a range («goal 2400», «del 12», chatter) and other branches handle it.
  const rest = text
    .replace(DATE, ' ')
    .toLowerCase()
    .replace(/[-–—]|\.\./g, ' ')
    // `\b` is ASCII-only in JS, so Cyrillic words are delimited by hand.
    .replace(/(^|\s)(с|по|до|from|to)(?=\s|$)/g, ' ')
    .trim();
  if (rest !== '') return null;
  if (tokens.length === 0 || tokens.length > 2) return null;
  const dates = tokens.map((tk) => parseFoodDate(tk, today));
  if (dates.some((x) => x === null)) return null;
  const [a, b = a] = dates as string[];
  return a! <= b! ? { from: a!, to: b! } : { from: b!, to: a! };
}

/**
 * Parse `/food` arguments. Pure, so the grammar is unit-tested:
 * (none)/today · yesterday/вчера · week · month · <N>d · <date> · <date>-<date> ·
 * goal <kcal> [Б Ж У] (brackets optional) · goal off · del <id> [id…].
 */
export function parseFoodArgs(
  raw: string,
  today: string = new Date().toISOString().slice(0, 10),
): FoodCommand {
  const range = parseFoodRange(raw, today);
  if (range) return { kind: 'range', ...range };
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
    // Read the NUMBERS, forgive the wrapping: people copy the help's shape
    // literally («goal 2400 [150 65 300]») or label them («б150 ж65 у300»,
    // «2400ккал»). Order is always kcal, then Б Ж У.
    const nums = (rest.join(' ').match(/\d+(?:[.,]\d+)?/g) ?? []).map((x) =>
      Number(x.replace(',', '.')),
    );
    if (nums.length === 0 || nums.length > 4 || nums[0]! <= 0) {
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
  '/food — сегодня · /food вчера · /food 28.09 — конкретный день\n' +
  'Статистика по дням (ккал и БЖУ): /food week · /food month · /food 14d · /food 01.09-15.09\n' +
  '/food goal 2000 — дневная цель в ккал; можно сразу с БЖУ в граммах: /food goal 2400 150 65 300 · /food goal off\n' +
  'Поправить или удалить запись — просто скажи: «убери шпроты», «курицы было 150 г».';

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
  const today = localToday(foodTimezone(chatId));
  const cmd = parseFoodArgs((ctx.match as string | undefined) ?? '', today);
  const inThread = { messageThreadId: threadIdOf(ctx.msg) };

  switch (cmd.kind) {
    // Tables go out as rich markdown (native Telegram table, aligned <pre> fallback).
    case 'day': {
      const d = shiftDays(today, cmd.offset);
      await sendRichMarkdown(ctx.api, chatId, renderFoodReport(chatId, userId, d, d, today), inThread);
      return;
    }
    case 'period':
      await sendRichMarkdown(
        ctx.api,
        chatId,
        renderFoodReport(chatId, userId, shiftDays(today, -(cmd.days - 1)), today, today),
        inThread,
      );
      return;
    case 'range':
      // One day renders as the full diary, a span as the per-day table;
      // renderFoodReport clamps the future and over-long spans (92 days).
      await sendRichMarkdown(
        ctx.api,
        chatId,
        renderFoodReport(chatId, userId, cmd.from, cmd.to, today),
        inThread,
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
