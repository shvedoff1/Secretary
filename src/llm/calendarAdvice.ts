import type Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { getAnthropic } from './client.js';

// The «умная» half of a calendar reminder: ONE short advice/quip line appended
// UNDER the deterministically-rendered digest. The model never renders the event
// list itself — titles and times reach the chat verbatim from the calendar, and
// the worst this line can do is be unfunny. Best-effort: any failure → no line.

const ADVICE_SYSTEM = `Ты пишешь ОДНУ короткую строку-приписку (максимум две) под напоминанием
Telegram-бота о событиях из календаря пользователя. Сам список событий уже
показан выше — твоя строка идёт ПОД ним.

Твоя задача — практичный, конкретный совет по подготовке, привязанный к самим
событиям: ранний подъём => во сколько встать, собрать вещи и заказать такси с
вечера; самолёт/поезд => документы, выехать с запасом; врач => полис/карта;
встреча/созвон => подготовить материалы; день рождения => подарок. Если событий
несколько — выбери самое требующее подготовки, не комментируй каждое.

Правила:
- НЕ пересказывай список и НЕ повторяй времена/названия сплошняком — событие
  можно упомянуть кратко, чтобы совет был адресным.
- НЕ выдумывай события, времена и детали, которых нет в списке. Здравый смысл
  («в аэропорт лучше за 2 часа») — можно, конкретика из воздуха — нельзя.
- Без markdown-заголовков и списков: одна-две строки обычного текста.
- Если полезного совета нет — выведи ровно NOTHING (одним словом, латиницей).

Тон задаётся в запросе: «шутливо» — дружеский стёб, разговорный русский, можно
дерзко, но по-доброму; «спокойно» — по делу, без шуток.`;

export interface CalendarAdviceArgs {
  /** The already-rendered digest text (what the user will see above the line). */
  noticeText: string;
  kind: 'evening' | 'morning' | 'soon';
  /** Any timed event starts early — lean into the prep advice. */
  hasEarly: boolean;
  /** Joking tone (chat humour on) vs plain practical tone. */
  funny: boolean;
}

/**
 * Ask the cheap model for the advice line. Returns null when there is nothing
 * worth saying or on ANY failure — the digest ships fine without it.
 */
export async function calendarAdviceLine(args: CalendarAdviceArgs): Promise<string | null> {
  const cfg = loadConfig();
  const kindLabel =
    args.kind === 'evening'
      ? 'вечернее напоминание о завтрашних событиях'
      : args.kind === 'morning'
        ? 'утреннее напоминание о сегодняшних событиях'
        : 'напоминание незадолго до события';
  const early = args.hasEarly
    ? '\nВажно: есть РАННЕЕ событие — совет про подъём/сборы/выезд особенно уместен.'
    : '';
  try {
    const res = await getAnthropic().messages.create({
      model: cfg.ANTHROPIC_CALENDAR_MODEL,
      max_tokens: 300,
      system: ADVICE_SYSTEM,
      messages: [
        {
          role: 'user',
          content:
            `Тип: ${kindLabel}. Тон: ${args.funny ? 'шутливо' : 'спокойно'}.${early}\n\n` +
            `Текст напоминания:\n${args.noticeText}`,
        },
      ],
    });
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    if (!text || /^nothing$/i.test(text) || text.length > 500) return null;
    return text;
  } catch (err) {
    logger.warn({ err }, 'calendar advice line failed');
    return null;
  }
}
