import type { Context } from 'grammy';
import { loadConfig } from '../../config.js';
import { logger } from '../../logger.js';
import {
  addCalendar,
  deleteCalendar,
  findCalendarByUrl,
  forceFetch,
  listCalendars,
  listEvents,
  maskIcsUrl,
  replaceEvents,
  setFetchResult,
} from '../../db/repos/calendar.repo.js';
import { fetchIcs } from '../../calendar/fetch.js';
import { expandIcs, icsCalendarName, looksLikeIcs } from '../../calendar/ics.js';
import { upcomingCalendarLines } from '../../calendar/handler.js';
import { getTimezone } from '../../db/repos/chatSettings.repo.js';
import { canManageChat } from '../permissions.js';
import { formatInTimezone } from '../../util/schedule.js';

const DAY_MS = 86_400_000;

/**
 * /calendar — подключение Google Календаря по СЕКРЕТНОЙ iCal-ссылке:
 *   /calendar                       — список календарей чата + настройки напоминаний
 *   /calendar add <ссылка> [имя]    — подключить (ссылка сразу проверяется)
 *   /calendar del <id>              — отключить (кэш событий стирается)
 *   /calendar check                 — обновить кэш сейчас (следующий тик)
 * Админская форма из лички: /calendar <chatId> [add …|del …|check].
 *
 * SECURITY: the ICS link grants read access to the whole calendar, so it is
 * never echoed back (masked), and when it is posted in a GROUP the bot tries to
 * delete the message carrying it and says to prefer the DM form next time.
 */
export async function cmdCalendar(ctx: Context): Promise<void> {
  const cfg = loadConfig();
  if (!ctx.chat || !ctx.from) return;
  if (!cfg.ENABLE_CALENDAR) {
    await ctx.reply('Календарь выключен глобально (ENABLE_CALENDAR=false).');
    return;
  }

  const tokens = (((ctx.match as string | undefined) ?? '').trim())
    .split(/\s+/)
    .filter(Boolean);

  // Cross-chat admin form: a LONG first number is a chat id (a short one would
  // be a calendar id for del). DM-only + chat-manager rights, like /slang.
  let chatId = ctx.chat.id;
  if (tokens[0] && /^-?\d{5,}$/.test(tokens[0])) {
    chatId = Number(tokens.shift());
    if (ctx.chat.type !== 'private') {
      await ctx.reply('Управление чужим чатом — только в личке со мной.');
      return;
    }
    if (!canManageChat(ctx.from.id, chatId)) {
      await ctx.reply('Этот чат тебе не доступен.');
      return;
    }
  }

  const sub = (tokens.shift() ?? '').toLowerCase();

  if (sub === 'add') {
    await handleAdd(ctx, chatId, tokens);
    return;
  }

  if (sub === 'del') {
    const id = Number(tokens[0]);
    if (!tokens[0] || !Number.isInteger(id)) {
      await ctx.reply('Использование: /calendar del <id> (id смотри в /calendar)');
      return;
    }
    const ok = deleteCalendar(id, chatId);
    await ctx.reply(
      ok
        ? `🗑 Календарь #${id} отключён, кэш событий стёрт. Напоминаний по нему больше не будет.`
        : `Не нашёл календарь #${id} в этом чате.`,
    );
    return;
  }

  if (sub === 'check') {
    const n = forceFetch(chatId);
    await ctx.reply(
      n > 0
        ? '🔄 Обновлю календарь в течение минуты.'
        : 'В этом чате нет подключённых календарей. Подключить: /calendar add <секретная ICS-ссылка>',
    );
    return;
  }

  if (sub) {
    await ctx.reply('Использование: /calendar [add <ссылка> [имя] | del <id> | check]');
    return;
  }

  await renderList(ctx, chatId);
}

async function renderList(ctx: Context, chatId: number): Promise<void> {
  const cfg = loadConfig();
  const cals = listCalendars(chatId);
  if (cals.length === 0) {
    await ctx.reply(
      [
        'Календарь не подключён. Подключи свой Google Календарь — буду сам напоминать о событиях и отвечать «что у меня завтра».',
        '',
        'Как подключить:',
        '1. Google Календарь (в браузере) → настройки нужного календаря → «Интеграция календаря».',
        '2. Скопируй «Секретный адрес в формате iCal» (ссылка …basic.ics).',
        '3. Пришли мне: /calendar add <ссылка>',
        '',
        '⚠️ Ссылка СЕКРЕТНАЯ (по ней виден весь календарь) — лучше подключать в личке со мной; я вижу её только для чтения.',
      ].join('\n'),
    );
    return;
  }
  const tz = getTimezone(chatId) ?? cfg.DEFAULT_TIMEZONE;
  const now = Date.now();
  const lines: string[] = ['🗓 Календари этого чата:'];
  for (const cal of cals) {
    const events = listEvents(chatId, now - DAY_MS, now + cfg.CALENDAR_HORIZON_DAYS * DAY_MS);
    const count = events.filter((e) => e.calendarId === cal.id).length;
    const sync = cal.lastOkAt ? formatInTimezone(cal.lastOkAt, tz) : 'ещё не было';
    const fails =
      cal.failCount > 0 ? ` ⚠️ ${cal.failCount} неудачных обновлений подряд` : '';
    lines.push(
      `#${cal.id} «${cal.name}» — ${maskIcsUrl(cal.icsUrl)}\n   событий в кэше (≤${cfg.CALENDAR_HORIZON_DAYS} дн.): ${count}, синхронизация: ${sync}${fails}`,
    );
  }
  const next = upcomingCalendarLines(chatId, tz, 5);
  if (next.length > 0) {
    lines.push('', 'Ближайшее:');
    for (const l of next) lines.push(`• ${l}`);
  }
  lines.push(
    '',
    `Напоминания: вечером в ${cfg.CALENDAR_EVENING_HOUR}:00 — про завтра, утром в ${cfg.CALENDAR_MORNING_HOUR}:00 — про сегодня, и за ~${cfg.CALENDAR_SOON_MINUTES} мин до события (часовой пояс: ${tz}).`,
    'Команды: /calendar add <ссылка> [имя] · /calendar del <id> · /calendar check',
  );
  await ctx.reply(lines.join('\n'), { link_preview_options: { is_disabled: true } });
}

async function handleAdd(ctx: Context, chatId: number, tokens: string[]): Promise<void> {
  const cfg = loadConfig();
  const url = tokens.shift() ?? '';
  const givenName = tokens.join(' ').trim();

  // The message carries a SECRET — in a group, get it off the screen first,
  // whatever happens next (best-effort: needs delete rights).
  let deleted = false;
  if (ctx.chat?.type !== 'private') {
    try {
      await ctx.deleteMessage();
      deleted = true;
    } catch {
      /* no rights — warned below */
    }
  }
  const groupWarning =
    ctx.chat?.type !== 'private'
      ? deleted
        ? '\n🔒 Сообщение со ссылкой я удалил — она секретная. В следующий раз лучше подключать в личке со мной.'
        : '\n⚠️ Ссылка секретная, а удалить твоё сообщение у меня прав нет — удали его сам и лучше подключай календарь в личке со мной.'
      : '';

  if (!/^(https?|webcal):\/\//i.test(url)) {
    await ctx.reply(
      'Нужна секретная iCal-ссылка: Google Календарь → настройки календаря → «Интеграция календаря» → «Секретный адрес в формате iCal». Затем: /calendar add <ссылка>' +
        groupWarning,
    );
    return;
  }
  if (findCalendarByUrl(chatId, url)) {
    await ctx.reply(`Этот календарь уже подключён. Список: /calendar${groupWarning}`);
    return;
  }
  const existing = listCalendars(chatId);
  if (existing.length >= cfg.CALENDAR_MAX_PER_CHAT) {
    await ctx.reply(
      `В этом чате уже ${existing.length} календарей — это потолок. Отключи лишний: /calendar del <id>${groupWarning}`,
    );
    return;
  }

  // Verify the link NOW — a secret that doesn't read is not stored.
  let text: string;
  try {
    text = await fetchIcs(url);
  } catch (err) {
    logger.warn({ err, chatId }, 'calendar add: fetch failed');
    await ctx.reply(
      'Не смог открыть ссылку. Проверь, что это именно «Секретный адрес в формате iCal» (а не обычная ссылка на календарь), и попробуй ещё раз.' +
        groupWarning,
    );
    return;
  }
  if (!looksLikeIcs(text)) {
    await ctx.reply(
      'По ссылке не iCal-файл. Нужен «Секретный адрес в формате iCal» из настроек Google Календаря (обычно кончается на basic.ics).' +
        groupWarning,
    );
    return;
  }

  const name =
    givenName || icsCalendarName(text) || `календарь ${existing.length + 1}`;
  const now = Date.now();
  const id = addCalendar({ chatId, tgUserId: ctx.from?.id ?? null, name, icsUrl: url });
  const events = expandIcs(text, now - DAY_MS, now + cfg.CALENDAR_HORIZON_DAYS * DAY_MS);
  replaceEvents(id, chatId, events);
  setFetchResult(id, {
    ok: true,
    nowMs: now,
    nextFetchAt: now + cfg.CALENDAR_FETCH_MINUTES * 60_000,
    failCount: 0,
  });

  const tz = getTimezone(chatId) ?? cfg.DEFAULT_TIMEZONE;
  const tzNote =
    getTimezone(chatId) === null
      ? `\n⏱ Часовой пояс чата не задан — напоминания пойдут по ${tz}. Скажи мне «мой часовой пояс — <город>», чтобы поправить.`
      : '';
  const peek = upcomingCalendarLines(chatId, tz, 3)
    .map((l) => `• ${l}`)
    .join('\n');
  await ctx.reply(
    [
      `✅ Календарь «${name}» подключён (#${id}). Событий на ближайшие ${cfg.CALENDAR_HORIZON_DAYS} дней: ${events.length}.`,
      peek ? `Ближайшее:\n${peek}` : 'В ближайшие дни событий не видно.',
      `Буду напоминать: вечером в ${cfg.CALENDAR_EVENING_HOUR}:00 — что завтра, утром в ${cfg.CALENDAR_MORNING_HOUR}:00 — что сегодня, и за ~${cfg.CALENDAR_SOON_MINUTES} мин до события. Спросить можно словами: «что у меня завтра?»${tzNote}${groupWarning}`,
    ].join('\n'),
    { link_preview_options: { is_disabled: true } },
  );
}
