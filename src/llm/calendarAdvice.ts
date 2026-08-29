import type Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { getAnthropic } from './client.js';

// The «умная» half of a calendar reminder: a short advice block appended UNDER
// the deterministically-rendered digest. The model never renders the event list
// itself — titles and times reach the chat verbatim from the calendar; this
// pass only adds preparation advice. Best-effort: any failure → no line.
//
// Concreteness is the whole point (feedback: «убедись, что паспорт под рукой» is
// useless). The model gets more than the digest shows — event DESCRIPTIONS
// (bookings often carry the terminal/seat/confirmation), locations and the
// current local time — and the prompt demands specific, computed advice while
// drawing a hard line: known facts about famous PLACES are welcome, invented
// BOOKING data (terminals, gates, times not present in the data) are not.

const ADVICE_SYSTEM = `Ты пишешь короткую приписку (1-4 строки) под напоминанием Telegram-бота о
событиях из календаря пользователя. Список событий уже показан выше — твоя
приписка идёт ПОД ним и должна быть КОНКРЕТНОЙ подготовкой, а не дежурной фразой.

Плохо (слишком общо, так НЕ писать): «Убедись, что паспорт под рукой, в аэропорт
лучше за 2 часа». Хорошо — привязка к конкретным местам, временам и данным:
«Вылет в 11:25 из SGN (Таншоннят) — до аэропорта из центра Хошимина 30-50 минут
по пробкам, международный терминал — T2. Выезжай к 8:30, посадочный в телефон,
для Камбоджи можно e-visa или виза по прилёте (30$, фото)».

Как этого добиться:
- СЧИТАЙ время сам: от времени события отними дорогу и запас и назови конкретное
  время выезда/подъёма. Текущее локальное время дано в запросе.
- Используй свои ЗНАНИЯ об известных местах из событий — аэропортах, вокзалах,
  городах, районах: какой это аэропорт, сколько до него ехать, большой или
  маленький, какие там очереди, визовые правила страны, сезонная погода. Если
  уверен в факте о месте — говори его; если не уверен — не выдумывай.
- В ДЕТАЛЯХ событий (ниже списка) часто лежат номер брони, терминал, место,
  адрес — используй их, они точные.
- НИКОГДА не выдумывай данные КОНКРЕТНОЙ брони/рейса, которых нет в данных:
  терминал, гейт, время, номер места. Общее знание («в SGN международные рейсы —
  T2») — можно; «твой гейт B12» из воздуха — нельзя.
- Если событий несколько — сфокусируйся на самом требующем подготовки, остальные
  можно затронуть полсловом или не трогать.
- Без markdown-заголовков; обычный текст, можно 1-2 эмодзи.
- Если сказать реально нечего — выведи ровно NOTHING (одним словом, латиницей).

Тон задаётся в запросе: «шутливо» — дружеский стёб, разговорный русский, можно
дерзко, но по-доброму (и совет всё равно конкретный); «спокойно» — по делу.`;

export interface CalendarAdviceArgs {
  /** The already-rendered digest text (what the user will see above the line). */
  noticeText: string;
  kind: 'evening' | 'morning' | 'soon';
  /** Any timed event starts early — lean into the prep advice. */
  hasEarly: boolean;
  /** Joking tone (chat humour on) vs plain practical tone. */
  funny: boolean;
  /** Chat timezone + the current local time there, for «выезжай к 8:30» math. */
  tz?: string;
  nowLocal?: string;
  /** Per-event extra detail the digest doesn't show (descriptions, locations). */
  details?: string[];
}

/**
 * Ask the cheap model for the advice block. Returns null when there is nothing
 * worth saying or on ANY failure — the digest ships fine without it.
 */
export async function calendarAdviceLine(args: CalendarAdviceArgs): Promise<string | null> {
  const cfg = loadConfig();
  const kindLabel =
    args.kind === 'evening'
      ? 'вечернее напоминание о ЗАВТРАШНИХ событиях'
      : args.kind === 'morning'
        ? 'утреннее напоминание о СЕГОДНЯШНИХ событиях'
        : 'напоминание незадолго до события';
  const early = args.hasEarly
    ? '\nВажно: есть РАННЕЕ событие — посчитай подъём/сборы/выезд и предложи, что сделать с вечера.'
    : '';
  const now =
    args.nowLocal && args.tz ? `\nСейчас у пользователя: ${args.nowLocal} (${args.tz}).` : '';
  const details =
    args.details && args.details.length > 0
      ? `\n\nДетали событий (не показаны в списке выше — бронь/адреса/описания, данные точные):\n${args.details.map((d) => `- ${d}`).join('\n')}`
      : '';
  try {
    const res = await getAnthropic().messages.create({
      model: cfg.ANTHROPIC_CALENDAR_MODEL,
      max_tokens: 600,
      system: ADVICE_SYSTEM,
      messages: [
        {
          role: 'user',
          content:
            `Тип: ${kindLabel}. Тон: ${args.funny ? 'шутливо' : 'спокойно'}.${early}${now}\n\n` +
            `Текст напоминания:\n${args.noticeText}${details}`,
        },
      ],
    });
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    if (!text || /^nothing$/i.test(text) || text.length > 900) return null;
    return text;
  } catch (err) {
    logger.warn({ err }, 'calendar advice line failed');
    return null;
  }
}
