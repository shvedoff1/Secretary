import type { Bot } from 'grammy';
import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import {
  dueCalendars,
  setFetchResult,
  replaceEvents,
  type ChatCalendar,
} from '../db/repos/calendar.repo.js';
import { fetchIcs } from './fetch.js';
import { expandIcs, looksLikeIcs } from './ics.js';

const DAY_MS = 86_400_000;
// After this many consecutive fetch failures the chat gets ONE heads-up (the
// poller keeps retrying) — same shape as the page-watch poller. A revoked secret
// address (Google's «сбросить» button) is the typical cause.
const FAIL_NOTIFY_COUNT = 10;

/**
 * Fetch one due calendar feed and swap the cached event window. The secret URL
 * never reaches logs or chat messages — failures are reported by calendar name.
 */
async function fetchCalendar(bot: Bot, cal: ChatCalendar): Promise<void> {
  const cfg = loadConfig();
  const now = Date.now();
  const nextFetchAt = now + cfg.CALENDAR_FETCH_MINUTES * 60_000;

  try {
    const text = await fetchIcs(cal.icsUrl);
    if (!looksLikeIcs(text)) throw new Error('feed is not an iCalendar file');
    const events = expandIcs(text, now - DAY_MS, now + cfg.CALENDAR_HORIZON_DAYS * DAY_MS);
    replaceEvents(cal.id, cal.chatId, events);
    setFetchResult(cal.id, { ok: true, nowMs: now, nextFetchAt, failCount: 0 });
    logger.debug(
      { calendarId: cal.id, chatId: cal.chatId, events: events.length },
      'calendar fetched',
    );
  } catch (err) {
    const failCount = cal.failCount + 1;
    logger.warn(
      { err, calendarId: cal.id, chatId: cal.chatId, failCount },
      'calendar fetch failed',
    );
    setFetchResult(cal.id, { ok: false, nowMs: now, nextFetchAt, failCount });
    if (failCount === FAIL_NOTIFY_COUNT) {
      await bot.api.sendMessage(
        cal.chatId,
        `⚠️ Календарь «${cal.name}» не читается уже ${failCount} попыток подряд. ` +
          `Похоже, секретная ссылка сброшена или недоступна — возьми свежую в настройках ` +
          `Google Календаря и переподключи: /calendar del ${cal.id}, затем /calendar add <ссылка>.`,
      );
    }
  }
}

/** Fetch every calendar whose next poll is due. Called from the minute tick. */
export async function runDueCalendarFetches(bot: Bot): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.ENABLE_CALENDAR) return;
  let cals: ChatCalendar[];
  try {
    cals = dueCalendars(Date.now());
  } catch (err) {
    logger.warn({ err }, 'failed to query due calendars');
    return;
  }
  for (const cal of cals) {
    try {
      await fetchCalendar(bot, cal);
    } catch (err) {
      // fetchCalendar handles its own errors; this guards the notify path. Push
      // the next poll out so a poisoned calendar can't spin on every tick.
      logger.error({ err, calendarId: cal.id }, 'calendar poll failed');
      try {
        setFetchResult(cal.id, {
          ok: false,
          nowMs: Date.now(),
          nextFetchAt: Date.now() + cfg.CALENDAR_FETCH_MINUTES * 60_000,
          failCount: cal.failCount + 1,
        });
      } catch {
        /* nothing more we can do */
      }
    }
  }
}
