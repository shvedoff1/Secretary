import type { Context } from 'grammy';
import { loadConfig } from '../../config.js';
import {
  getDailySpending,
  getTimezone,
  setDailySpendingEnabled,
} from '../../db/repos/chatSettings.repo.js';
import { getChatConfig } from '../../db/repos/chatConfig.repo.js';
import { renderYesterdayReport } from '../../spending/daily.js';
import { previousDateStr, zonedParts } from '../../util/day.js';
import { mdToTelegramHtml, stripMarkdown } from '../../util/telegramHtml.js';
import { logger } from '../../logger.js';

const ON_ARGS = new Set(['on', 'вкл', 'включить', 'start']);
const OFF_ARGS = new Set(['off', 'выкл', 'выключить', 'стоп', 'stop']);
const NOW_ARGS = new Set(['now', 'сейчас', 'показать', 'test']);

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function parseTime(arg: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(arg);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

async function sendReport(ctx: Context, text: string): Promise<void> {
  try {
    await ctx.reply(mdToTelegramHtml(text), { parse_mode: 'HTML' });
  } catch {
    await ctx.reply(stripMarkdown(text));
  }
}

/**
 * `/spending` — manage the per-chat daily spending digest (yesterday's expenses,
 * pulled from Splid and run through the humorizer).
 *   /spending            — show status
 *   /spending on [HH:MM] — enable (default 09:00 chat-local)
 *   /spending off        — disable
 *   /spending now        — post yesterday's report right now
 */
export async function cmdSpending(ctx: Context): Promise<void> {
  if (!ctx.chat) return;
  const chatId = ctx.chat.id;
  const cfg = loadConfig();
  const raw = ((ctx.match as string | undefined) ?? '').trim();
  const parts = raw.length ? raw.split(/\s+/) : [];
  const arg = (parts[0] ?? '').toLowerCase();
  const rest = parts.slice(1);

  const tz = getTimezone(chatId) ?? cfg.DEFAULT_TIMEZONE;
  const linked = !!getChatConfig(chatId)?.provider_group_id;

  if (ON_ARGS.has(arg)) {
    let hour = 9;
    let minute = 0;
    if (rest[0]) {
      const t = parseTime(rest[0]);
      if (!t) {
        await ctx.reply('Время не распознал. Формат: /spending on 09:00');
        return;
      }
      hour = t.hour;
      minute = t.minute;
    }
    // Seed the "already posted" guard with the day that would be due right now,
    // so the digest starts cleanly the next morning instead of back-filling.
    const today = zonedParts(Date.now(), tz).dateStr;
    setDailySpendingEnabled(chatId, true, {
      hour,
      minute,
      lastDate: previousDateStr(today),
    });
    const when = `${pad(hour)}:${pad(minute)}`;
    const note = linked
      ? `Первый отчёт — завтра в ${when}. Глянуть прямо сейчас: /spending now`
      : `Только сначала подключите группу Splid: /group <код>.`;
    await ctx.reply(`✅ Ежедневный отчёт о тратах включён (в ${when}). ${note}`);
    return;
  }

  if (OFF_ARGS.has(arg)) {
    setDailySpendingEnabled(chatId, false);
    await ctx.reply('🚫 Ежедневный отчёт о тратах выключен.');
    return;
  }

  if (NOW_ARGS.has(arg)) {
    if (!linked) {
      await ctx.reply('Группа Splid не подключена. Используйте /group <код>.');
      return;
    }
    try {
      const text = await renderYesterdayReport(chatId);
      if (text) await sendReport(ctx, text);
      else await ctx.reply('Группа Splid не подключена. Используйте /group <код>.');
    } catch (err) {
      logger.warn({ err, chatId }, 'manual spending report failed');
      await ctx.reply('Не удалось собрать отчёт — Splid не ответил. Попробуйте позже.');
    }
    return;
  }

  // No / unknown argument: show status.
  const s = getDailySpending(chatId);
  if (!s?.enabled) {
    await ctx.reply(
      'Ежедневный отчёт о тратах выключен.\n' +
        'Включить: /spending on [ЧЧ:ММ] (по умолчанию 09:00)\n' +
        'Показать за вчера: /spending now',
    );
    return;
  }
  const when = `${pad(s.hour)}:${pad(s.minute)}`;
  const lines = [`Ежедневный отчёт о тратах включён — каждый день в ${when}.`];
  if (!linked) lines.push('⚠️ Группа Splid не подключена (/group <код>) — отправлять нечего.');
  lines.push('Выключить: /spending off · Показать за вчера: /spending now');
  await ctx.reply(lines.join('\n'));
}
