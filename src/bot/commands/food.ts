import type { Context } from 'grammy';
import { loadConfig } from '../../config.js';
import { foodAllowedIn } from '../../core/chatScope.js';
import {
  clearFoodGoal,
  deleteDayType,
  findDayType,
  getDayKind,
  getFoodGoal,
  listDayTypes,
  setDayKind,
  upsertDayType,
  getDayNote,
  removeFoodEntries,
  setDayNote,
  setFoodGoal,
} from '../../db/repos/food.repo.js';
import {
  foodTimezone,
  localToday,
  renderFoodReport,
  shiftDays,
} from '../../food/handler.js';
import { DAY_NOTE_MAX, fmtNum, mergeDayNote } from '../../food/nutrition.js';
import { threadIdOf } from '../threads.js';
import { sendRichMarkdown } from '../../util/richMessage.js';
import { dayTypeKeyboard } from '../../food/dayTypeKeyboard.js';

export type FoodCommand =
  | { kind: 'day'; offset: number }
  | { kind: 'period'; days: number }
  | { kind: 'range'; from: string; to: string }
  | { kind: 'goal'; kcal: number; protein: number | null; fat: number | null; carbs: number | null }
  | { kind: 'goal_off' }
  | { kind: 'del'; ids: number[] }
  | { kind: 'note'; date: string; text: string | null }
  | { kind: 'types' }
  | {
      kind: 'type_set';
      name: string;
      kcal: number;
      protein: number | null;
      fat: number | null;
      carbs: number | null;
    }
  | { kind: 'type_del'; name: string }
  | { kind: 'day_pick'; date: string }
  | { kind: 'day_set'; date: string; name: string | null }
  | { kind: 'help' };

const WEEK = new Set(['week', 'неделя', 'неделю', '7']);
const MONTH = new Set(['month', 'месяц', '30']);
const NOTE = new Set(['note', 'заметка', 'коммент', 'комментарий']);
const CLEAR_NOTE = new Set(['clear', 'off', 'удали', 'убери', 'сброс', '-']);
const TYPES = new Set(['types', 'типы']);
const TYPE = new Set(['type', 'тип']);
const DAY = new Set(['day', 'день']);
const DEFAULT_DAY = new Set(['обычный', 'обычн', 'default', 'none', 'без', 'clear']);

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
  if (TYPES.has(head)) return { kind: 'types' };
  if (TYPE.has(head)) {
    // «/food type add тренировка 2600 180 70 300» · «/food type del отдых» —
    // the verb is optional before a definition («/food type отдых 2200»).
    const words = raw.trim().split(/\s+/).slice(1);
    const verb = (words[0] ?? '').toLowerCase();
    if (['del', 'rm', 'удали', 'удалить', '-'].includes(verb)) {
      const name = words.slice(1).join(' ').trim();
      return name ? { kind: 'type_del', name } : { kind: 'help' };
    }
    const body = (['add', 'set', 'добавь', 'добавить', '+'].includes(verb) ? words.slice(1) : words).join(' ');
    const firstNum = body.search(/\d/);
    if (firstNum <= 0) return { kind: 'help' };
    const name = body.slice(0, firstNum).replace(/[\[\]():,—-]+$/g, '').trim();
    const nums = (body.slice(firstNum).match(/\d+(?:[.,]\d+)?/g) ?? []).map((x) => Number(x.replace(',', '.')));
    if (!name || nums.length === 0 || nums.length > 4 || nums[0]! <= 0) return { kind: 'help' };
    return {
      kind: 'type_set',
      name,
      kcal: Math.round(nums[0]!),
      protein: nums[1] ?? null,
      fat: nums[2] ?? null,
      carbs: nums[3] ?? null,
    };
  }
  if (DAY.has(head)) {
    // «/food day» (buttons) · «/food day отдых» · «/food day 28.09 тренировка».
    const words = raw.trim().split(/\s+/).slice(1);
    const dated = words[0] ? parseFoodDate(words[0], today) : null;
    const date = dated ?? today;
    const name = (dated ? words.slice(1) : words).join(' ').trim();
    if (!name) return { kind: 'day_pick', date };
    return { kind: 'day_set', date, name: DEFAULT_DAY.has(name.toLowerCase()) ? null : name };
  }
  if (NOTE.has(head)) {
    // «/food note была тренировка» (today) · «/food note 28.09 болел» · «… clear».
    const raw2 = raw.trim().slice(raw.trim().split(/\s+/)[0]!.length).trim();
    const [first = '', ...tail] = raw2.split(/\s+/);
    const dated = first ? parseFoodDate(first, today) : null;
    const date = dated ?? today;
    const text = (dated ? tail.join(' ') : raw2).trim();
    if (!text) return { kind: 'help' };
    if (CLEAR_NOTE.has(text.toLowerCase())) return { kind: 'note', date, text: null };
    return { kind: 'note', date, text };
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
  'Типы дней (своя норма КБЖУ на каждый): /food type add тренировка 2600 180 70 300 · /food types · /food type del отдых\n' +
  '/food day — выбрать тип сегодняшнего дня кнопками · /food day отдых · /food day 28.09 тренировка\n' +
  '/food note была тренировка — заметка к сегодня · /food note 28.09 болел · /food note clear\n' +
  'Поправить или удалить запись — просто скажи: «убери шпроты», «курицы было 150 г». ' +
  'Заметку тоже можно словами: «сегодня была тренировка».';

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
  // The diary is personal and lives in the DM only (core/chatScope.ts).
  if (!foodAllowedIn(ctx.chat.id)) {
    await ctx.reply('Дневник калорий веду только в личке — напиши мне туда /food.');
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
    case 'types': {
      const types = listDayTypes(chatId, userId);
      const def = getFoodGoal(chatId, userId);
      if (types.length === 0) {
        await ctx.reply(
          'Типов дней пока нет. Например:\n/food type add тренировка 2600 180 70 300\n/food type add отдых 2200 150 70 220\n' +
            'Потом в первой записи за день я спрошу кнопками, какой сегодня день.',
        );
        return;
      }
      const line = (name: string, g: { kcal: number; protein: number | null; fat: number | null; carbs: number | null }) =>
        `• ${name}: ${fmtNum(g.kcal)} ккал${g.protein !== null ? ` · Б ${fmtNum(g.protein)}` : ''}${g.fat !== null ? ` · Ж ${fmtNum(g.fat)}` : ''}${g.carbs !== null ? ` · У ${fmtNum(g.carbs)}` : ''}`;
      await ctx.reply(
        ['Типы дней:', ...types.map((t) => line(t.name, t)), ...(def ? [line('обычный (без типа)', def)] : [])].join('\n') +
          '\n\nСменить тип дня: /food day',
      );
      return;
    }
    case 'type_set': {
      const res = upsertDayType(chatId, userId, cmd.name, {
        kcal: cmd.kcal,
        protein: cmd.protein,
        fat: cmd.fat,
        carbs: cmd.carbs,
      });
      if (res.status === 'full') {
        await ctx.reply(`Типов уже ${res.max} — это максимум. Удали лишний: /food type del <название>`);
        return;
      }
      await ctx.reply(
        `${res.status === 'created' ? '✅ Тип добавлен' : '✏️ Тип обновлён'}: ${res.type.name} — ${fmtNum(res.type.kcal)} ккал. Все типы: /food types`,
      );
      return;
    }
    case 'type_del': {
      const t = findDayType(chatId, userId, cmd.name);
      if (!t) {
        await ctx.reply('Такого типа нет (или подходит несколько). Список: /food types');
        return;
      }
      deleteDayType(chatId, userId, t.id);
      await ctx.reply(`🗑️ Тип «${t.name}» удалён — его дни считаются по обычной цели.`);
      return;
    }
    case 'day_pick': {
      const types = listDayTypes(chatId, userId);
      if (types.length === 0) {
        await ctx.reply('Сначала заведи типы дней: /food type add тренировка 2600 180 70 300');
        return;
      }
      const current = getDayKind(chatId, userId, cmd.date);
      await sendRichMarkdown(ctx.api, chatId, `Какой день ${cmd.date === today ? 'сегодня' : cmd.date}?`, {
        replyMarkup: dayTypeKeyboard(types, cmd.date, current?.id ?? null),
      });
      return;
    }
    case 'day_set': {
      if (cmd.name === null) {
        setDayKind(chatId, userId, cmd.date, null);
      } else {
        const t = findDayType(chatId, userId, cmd.name);
        if (!t) {
          await ctx.reply('Такого типа нет (или подходит несколько). Список: /food types');
          return;
        }
        setDayKind(chatId, userId, cmd.date, t.id);
      }
      await sendRichMarkdown(ctx.api, chatId, renderFoodReport(chatId, userId, cmd.date, cmd.date, today));
      return;
    }
    case 'note': {
      if (cmd.text === null) {
        setDayNote(chatId, userId, cmd.date, '');
      } else {
        const merged = mergeDayNote(getDayNote(chatId, userId, cmd.date), cmd.text, false);
        setDayNote(chatId, userId, cmd.date, merged.text);
        if (merged.cut) await ctx.reply(`Заметка длинная — обрезал до ${DAY_NOTE_MAX} символов.`);
      }
      // Show the day with its note, so the result is visible right away.
      await sendRichMarkdown(ctx.api, chatId, renderFoodReport(chatId, userId, cmd.date, cmd.date, today));
      return;
    }
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
