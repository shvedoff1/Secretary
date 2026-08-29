import { loadConfig } from '../config.js';
import type { CalendarEventsInput } from '../llm/schema.js';
import { listCalendars, listEvents, type CalendarEvent } from '../db/repos/calendar.repo.js';
import { getTimezone } from '../db/repos/chatSettings.repo.js';
import { isValidTimezone } from '../util/schedule.js';
import { startOfZonedDayMs, zonedDayRange } from '../util/day.js';
import { eventLocalDate, renderEventLine, dayLabel } from './notice.js';

const DAY_MS = 86_400_000;
// Token guard on one tool answer; the window can hold a dense work calendar.
const MAX_LINES = 60;

/**
 * Render events grouped by chat-local day. Pure — exported for tests.
 * The result is written for the MODEL: exact lines it must relay verbatim,
 * with every cache/window limitation stated so it never fills a gap itself.
 */
export function renderEventsForModel(
  events: CalendarEvent[],
  tz: string,
  args: { periodLabel: string; horizonNote: string | null },
): string {
  if (events.length === 0) {
    const tail = args.horizonNote ? `\n${args.horizonNote}` : '';
    return `В календаре нет событий за период: ${args.periodLabel}.${tail}`;
  }
  const out: string[] = [
    `События календаря (${args.periodLabel}), время местное (${tz}). Передавай названия и времена КАК ЕСТЬ:`,
  ];
  let day = '';
  let lines = 0;
  for (const e of events) {
    if (lines >= MAX_LINES) break;
    const d = eventLocalDate(e, tz);
    if (d !== day) {
      day = d;
      out.push(`${dayLabel(d)} (${d}):`);
    }
    out.push(`- ${renderEventLine(e, tz)}`);
    lines++;
  }
  if (events.length > MAX_LINES) {
    out.push(`(показаны первые ${MAX_LINES} из ${events.length} — скажи это пользователю, если важно)`);
  }
  if (args.horizonNote) out.push(args.horizonNote);
  return out.join('\n');
}

/**
 * Build the `calendar_events` handler for a chat. STRICTLY chat-scoped: it can
 * only ever read the calendars connected to `chatId` (the repo enforces the
 * same at the query layer), so one chat's events cannot surface in another.
 */
export function makeCalendarEventsHandler(
  chatId: number,
): (input: CalendarEventsInput) => string {
  return ({ fromDate, toDate, timezone }) => {
    const cfg = loadConfig();
    if (!cfg.ENABLE_CALENDAR) return 'Календарь выключен глобально (ENABLE_CALENDAR=false).';
    if (listCalendars(chatId).length === 0) {
      return 'К этому чату не подключён календарь. Подключается секретной ICS-ссылкой: /calendar add <ссылка> (Google Календарь → настройки календаря → «Секретный адрес в формате iCal»).';
    }
    const tz = isValidTimezone(timezone)
      ? timezone
      : (getTimezone(chatId) ?? cfg.DEFAULT_TIMEZONE);

    const now = Date.now();
    const horizonEndMs = now + cfg.CALENDAR_HORIZON_DAYS * DAY_MS;
    let fromMs = now - DAY_MS; // keep ongoing events visible
    let toMs = horizonEndMs;
    let periodLabel = `ближайшие ${cfg.CALENDAR_HORIZON_DAYS} дней`;
    if (fromDate) {
      const endDate = toDate ?? fromDate;
      fromMs = startOfZonedDayMs(fromDate, tz);
      toMs = zonedDayRange(endDate, tz).toMs;
      periodLabel = fromDate === endDate ? fromDate : `${fromDate} — ${endDate}`;
    }
    // The cache only reaches CALENDAR_HORIZON_DAYS ahead — a period beyond it
    // would silently look empty, so the limitation is stated instead.
    const horizonNote =
      toMs > horizonEndMs + DAY_MS
        ? `Кэш календаря видит только ~${cfg.CALENDAR_HORIZON_DAYS} дней вперёд — про более далёкие даты честно скажи, что не видишь их, и предложи спросить ближе к делу.`
        : null;

    const events = listEvents(chatId, fromMs, Math.min(toMs, horizonEndMs + DAY_MS));
    return renderEventsForModel(events, tz, { periodLabel, horizonNote });
  };
}

/**
 * The context-block peek: the next few upcoming events as pre-rendered lines
 * (chat-local time). Small on purpose — it is paid for on every turn; the tool
 * reads the full window.
 */
export function upcomingCalendarLines(chatId: number, tz: string, limit: number): string[] {
  const cfg = loadConfig();
  const now = Date.now();
  const events = listEvents(chatId, now - DAY_MS, now + cfg.CALENDAR_HORIZON_DAYS * DAY_MS)
    // An already-finished timed event is noise; ongoing and upcoming stay.
    .filter((e) => e.allDay || (e.endsAt ?? e.startsAt) >= now)
    .slice(0, limit);
  return events.map((e) => `${dayLabel(eventLocalDate(e, tz))} ${renderEventLine(e, tz)}`);
}

/** Whether this chat has at least one connected calendar (gates the tool). */
export function calendarConnected(chatId: number): boolean {
  const cfg = loadConfig();
  return cfg.ENABLE_CALENDAR && listCalendars(chatId).length > 0;
}
