import type { Bot } from 'grammy';
import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import {
  chatsWithCalendars,
  listEvents,
  wasNoticeSent,
  markNoticeSent,
  pruneNotices,
} from '../db/repos/calendar.repo.js';
import {
  planNotices,
  renderNotice,
  renderEventLine,
  type CalendarNotice,
  type NoticeEvent,
} from './notice.js';
import { calendarAdviceLine } from '../llm/calendarAdvice.js';
import { formatInTimezone } from '../util/schedule.js';
import {
  getTimezone,
  getChatMode,
  isChatHumorEnabled,
} from '../db/repos/chatSettings.repo.js';
import { modeAllowsHumor } from '../modes.js';
import { addTurn, pruneOld } from '../db/repos/conversation.repo.js';
import { recordChatLog } from '../bot/chatLog.js';

const DAY_MS = 86_400_000;
// Per-event cap on the description text fed to the advice model (bookings can
// carry pages of fare rules; the useful part — terminal/seat/confirmation —
// lives at the top).
const DETAIL_MAX_CHARS = 400;

/**
 * The advice model gets MORE than the digest shows: each event's description
 * (bookings often carry the terminal / seat / confirmation number) so its
 * advice can be concrete instead of «приезжай за 2 часа». Pure; exported for
 * tests.
 */
export function noticeDetails(events: NoticeEvent[], tz: string): string[] {
  const out: string[] = [];
  for (const e of events) {
    const desc = (e.description ?? '').replace(/\s*\n+\s*/g, ' • ').trim();
    if (!desc) continue;
    const cut = desc.length > DETAIL_MAX_CHARS ? `${desc.slice(0, DETAIL_MAX_CHARS)}…` : desc;
    out.push(`${renderEventLine(e, tz)}: ${cut}`);
  }
  return out;
}

/**
 * Send one planned notice: deterministic digest first, then the optional
 * cheap-model advice line under it. Notify FIRST, mark the slot after — a
 * failed Telegram send throws, the slot stays unsent and the next minute tick
 * retries (mirroring the watch poller's disarm order).
 */
async function sendNotice(bot: Bot, chatId: number, notice: CalendarNotice, tz: string): Promise<void> {
  const cfg = loadConfig();
  const body = renderNotice(notice, tz);

  // Tone: joking where the chat's humour is on (and the mode allows jokes at
  // all — a tutor room stays sober), plain practical advice otherwise. The
  // advice is Claude-side (no OpenAI dependency) and best-effort.
  const funny = modeAllowsHumor(getChatMode(chatId)) && isChatHumorEnabled(chatId);
  const advice = await calendarAdviceLine({
    noticeText: body,
    kind: notice.kind,
    hasEarly: notice.kind === 'soon' ? false : notice.hasEarly,
    funny,
    // Local now + the events' hidden details (booking descriptions) are what
    // turn the advice from «за 2 часа в аэропорт» into «выезжай к 8:30, T2».
    tz,
    nowLocal: formatInTimezone(Date.now(), tz),
    details: noticeDetails(notice.kind === 'soon' ? [notice.event] : notice.events, tz),
  });
  const text = advice ? `${body}\n\n${advice}` : body;

  await bot.api.sendMessage(chatId, text, {
    link_preview_options: { is_disabled: true },
  });
  markNoticeSent(chatId, notice.slot, Date.now());
  // Mirror the scheduler/watch pattern: the bot's own post lands in conversation
  // history and the raw log, so «а во сколько вылет?» right after has context.
  addTurn({ chatId, role: 'assistant', tgUserId: null, content: text });
  recordChatLog({ chatId, role: 'assistant', tgUserId: null, content: text });
  pruneOld(chatId, cfg.CONVERSATION_HISTORY_LIMIT * 2);
}

/**
 * The reminder half of the calendar feature: plan and send due notices for every
 * chat with a connected calendar. Called from the minute tick in index.ts.
 * Everything is per chat — a chat's plan only ever reads that chat's cached
 * events, so calendars cannot leak across chats by construction.
 */
export async function runDueCalendarNotices(bot: Bot): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.ENABLE_CALENDAR) return;

  let chatIds: number[];
  try {
    chatIds = chatsWithCalendars();
  } catch (err) {
    logger.warn({ err }, 'failed to query calendar chats');
    return;
  }
  const now = Date.now();

  for (const chatId of chatIds) {
    try {
      const tz = getTimezone(chatId) ?? cfg.DEFAULT_TIMEZONE;
      const events = listEvents(chatId, now - DAY_MS, now + cfg.CALENDAR_HORIZON_DAYS * DAY_MS);
      if (events.length === 0) continue;
      const notices = planNotices({
        events,
        nowMs: now,
        tz,
        eveningHour: cfg.CALENDAR_EVENING_HOUR,
        morningHour: cfg.CALENDAR_MORNING_HOUR,
        earlyHour: cfg.CALENDAR_EARLY_HOUR,
        soonMinutes: cfg.CALENDAR_SOON_MINUTES,
        isSent: (slot) => wasNoticeSent(chatId, slot),
      });
      for (const notice of notices) {
        await sendNotice(bot, chatId, notice, tz);
      }
    } catch (err) {
      // One chat's failure (Telegram send, LLM hiccup) must not starve the rest;
      // unsent slots re-plan on the next tick.
      logger.warn({ err, chatId }, 'calendar notices failed for chat');
    }
  }

  // Sent-slot rows are only needed while their slot could still be re-planned;
  // 60 days is far beyond any horizon.
  try {
    pruneNotices(now - 60 * DAY_MS);
  } catch {
    /* best-effort */
  }
}
