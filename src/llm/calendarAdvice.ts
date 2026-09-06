import type Anthropic from '@anthropic-ai/sdk';
import { loadConfig, type Config } from '../config.js';
import { logger } from '../logger.js';
import { getAnthropic } from './client.js';

// The «умная» half of a calendar reminder: a short advice block appended UNDER
// the deterministically-rendered digest. The model never renders the event list
// itself — titles and times reach the chat verbatim from the calendar; this
// pass only adds preparation advice. Best-effort: any failure → no line.
//
// Terminals, gates and airlines are BANNED from the model's own memory: asked
// for concrete advice it once sent a user flying Etihad out of Bangkok to
// «T1 или T3 для Emirates» — neither exists at BKK. Those facts reach the
// model only through the details block (booking description, or the live
// flight-feed line that calendar/flightFacts.ts adds when a feed is set).
//
// Concreteness is the whole point (feedback: «убедись, что паспорт под рукой» is
// useless). The model gets more than the digest shows — event DESCRIPTIONS
// (bookings often carry the terminal/seat/confirmation), locations and the
// current local time — and the prompt demands specific, computed advice while
// drawing a hard line: known facts about famous PLACES are welcome, invented
// BOOKING data (terminals, gates, times not present in the data) are not.

export const ADVICE_SYSTEM = `Ты пишешь короткую приписку (1-4 строки) под напоминанием Telegram-бота о
событиях из календаря пользователя. Список событий уже показан выше — твоя
приписка идёт ПОД ним и должна быть КОНКРЕТНОЙ подготовкой, а не дежурной фразой.

Плохо (слишком общо, так НЕ писать): «Убедись, что паспорт под рукой, главное не
опаздывай». Хорошо — привязка к конкретным местам, временам и данным:
«Вылет в 11:25 из SGN (Таншоннят) — до аэропорта из центра Хошимина 30-50 минут
по пробкам; в брони указан терминал 2. Выезжай к 8:30, посадочный в телефон,
для Камбоджи можно e-visa или виза по прилёте (30$, фото)». (Терминал здесь
взят из ДЕТАЛЕЙ брони, не из памяти — см. правило ниже.)

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
  терминал, гейт, время, номер места, авиакомпанию. ТЕРМИНАЛЫ, ГЕЙТЫ и
  АВИАКОМПАНИИ — только из деталей (бронь или строка «Рейс … данные …» из фида
  статусов), НИКОГДА из памяти: память путает аэропорты и авиакомпании (у
  Бангкока BKK нет деления на T1/T3, а рейс EY — это Etihad, не Emirates), и
  один такой ляп обнуляет доверие ко всей приписке. Нет терминала в деталях
  или фид пишет «не сообщает» — НЕ называй его вовсе или одной фразой отправь
  к брони/табло. Не гадай авиакомпанию по коду рейса. «Твой гейт B12» из
  воздуха — нельзя. Из общих знаний можно только то, в чём ты действительно
  уверен: какой это аэропорт и город, сколько до него ехать, визовые правила.
- Ошибка в деталях хуже пропуска: лучше короче и точно, чем длинно и с
  выдуманной подробностью.
- ПЕРЕЛЁТЫ — запас в аэропорту НЕ считай на глаз, это жёсткие минимумы:
  международный рейс — быть в аэропорту за 2-3 часа до вылета (никогда не
  советуй меньше 2; «за час до вылета» на международный — это опоздание, не
  совет), внутренний — за 1.5 часа. Дорогу и подъём считай от этого времени
  прибытия в аэропорт, не от времени вылета.
- Международный перелёт = граница: напомни про формальности обеих стран —
  визу и миграционные/таможенные карты или онлайн-декларации, которые многие
  страны требуют заполнить ЗАРАНЕЕ, до прилёта (например, Таиланд — цифровую
  карту прибытия TDAC заполняют онлайн, бумажных карт на границе больше нет).
  В вечернем напоминании предложи заполнить их с вечера. Уверен в требовании
  страны — называй его; не уверен — скажи «проверь, нужна ли онлайн-карта
  прибытия/декларация», но не выдумывай.
- Если событий несколько — сфокусируйся на самом требующем подготовки, остальные
  можно затронуть полсловом или не трогать.
- ПИНГ НЕЗАДОЛГО ДО СОБЫТИЯ: советуй ТОЛЬКО то, что реально успеть за оставшееся
  время (оно названо в запросе). Не предлагай подготовку, поезд на которую ушёл
  («собери вещи», «оформи e-visa» за 40 минут до вылета — поздно). ТРЕЗВО считай:
  если по твоей же арифметике времени НЕ хватает (до вылета час, ехать 40 минут,
  а надо быть за час) — не строй бодрый план «выезжай сейчас, успеешь»; скажи
  прямо, что время критичное, и назови единственное, что ещё имеет смысл сделать
  (такси немедленно / онлайн-регистрация по дороге / позвонить и перенести).
  Пользователь может быть уже на месте — не утверждай, где он; формулируй «если
  ещё не выехал — …».
- Без markdown-заголовков; обычный текст, можно 1-2 эмодзи.
- Если сказать реально нечего — выведи ровно NOTHING (одним словом, латиницей).

Тон задаётся в запросе: «шутливо» — дружеский стёб, разговорный русский, можно
дерзко, но по-доброму (и совет всё равно конкретный); «спокойно» — по делу.`;

/** Which model writes the advice: the override knob, else the main model. */
export function adviceModel(cfg: Pick<Config, 'ANTHROPIC_MODEL' | 'ANTHROPIC_CALENDAR_MODEL'>): string {
  return cfg.ANTHROPIC_CALENDAR_MODEL ?? cfg.ANTHROPIC_MODEL;
}

export interface CalendarAdviceArgs {
  /** The already-rendered digest text (what the user will see above the line). */
  noticeText: string;
  kind: 'evening' | 'morning' | 'soon';
  /** Any timed event starts early — lean into the prep advice. */
  hasEarly: boolean;
  /** For a 'soon' ping: minutes actually left — the hard budget the advice must
   *  fit into. Null for digests. */
  minutesLeft?: number | null;
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
  const left =
    args.minutesLeft != null
      ? `\nДо события осталось ${args.minutesLeft} мин — это ВЕСЬ бюджет времени: советуй только то, что в него влезает, и будь честен, если его не хватает.`
      : '';
  const now =
    args.nowLocal && args.tz ? `\nСейчас у пользователя: ${args.nowLocal} (${args.tz}).` : '';
  const details =
    args.details && args.details.length > 0
      ? `\n\nДетали событий (не показаны в списке выше — бронь/адреса/описания, данные точные):\n${args.details.map((d) => `- ${d}`).join('\n')}`
      : '';
  try {
    const res = await getAnthropic().messages.create({
      // The MAIN model, not the cheap tier: this is prose the user reads and
      // acts on (the same rule as every other user-facing reply) — Haiku here
      // produced the invented-terminal advice. The knob only overrides.
      model: adviceModel(cfg),
      max_tokens: 600,
      system: ADVICE_SYSTEM,
      messages: [
        {
          role: 'user',
          content:
            `Тип: ${kindLabel}. Тон: ${args.funny ? 'шутливо' : 'спокойно'}.${early}${left}${now}\n\n` +
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
