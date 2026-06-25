import type { Bot } from 'grammy';
import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { getProvider } from '../core/registry.js';
import { getChatConfig } from '../db/repos/chatConfig.repo.js';
import {
  getTimezone,
  listDailySpendingEnabled,
  setDailySpendingLastDate,
} from '../db/repos/chatSettings.repo.js';
import { humorizeOrOriginal } from '../llm/humorize.js';
import { mdToTelegramHtml, stripMarkdown } from '../util/telegramHtml.js';
import {
  aggregate,
  decideDue,
  formatDailyReport,
  yesterdayWindow,
  type DailyReportWindow,
} from './report.js';

async function sendMarkdown(bot: Bot, chatId: number, text: string): Promise<void> {
  try {
    await bot.api.sendMessage(chatId, mdToTelegramHtml(text), { parse_mode: 'HTML' });
  } catch (err) {
    logger.warn({ err, chatId }, 'daily spending HTML send failed, falling back to plain');
    await bot.api.sendMessage(chatId, stripMarkdown(text));
  }
}

/** Human label for the reported day, e.g. "24 июня", in the chat's timezone. */
function humanDate(window: DailyReportWindow, tz: string): string {
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      timeZone: tz,
      day: 'numeric',
      month: 'long',
    }).format(new Date(window.fromMs));
  } catch {
    return window.reportDate;
  }
}

/**
 * Build the (un-humorized) digest text for one chat's linked provider group.
 * Pulls members + expenses from the provider — reading straight from the source
 * of truth, so expenses added directly in the provider app are included too.
 */
async function buildReportText(
  cc: { provider_name: string; provider_group_id: string },
  window: DailyReportWindow,
  tz: string,
): Promise<string> {
  const provider = getProvider(cc.provider_name);
  const conn = { groupId: cc.provider_group_id };
  const [members, records] = await Promise.all([
    provider.listMembers(conn),
    provider.listExpenses(conn, { fromMs: window.fromMs, toMs: window.toMs }),
  ]);
  const names = new Map(members.map((m) => [m.id, m.name]));
  const agg = aggregate(records);
  return formatDailyReport(agg, names, { humanDate: humanDate(window, tz) });
}

/**
 * Render yesterday's digest for a chat on demand (used by `/spending now`),
 * already passed through the humorizer. Returns null when the chat has no
 * linked provider group.
 */
export async function renderYesterdayReport(
  chatId: number,
  now: number = Date.now(),
): Promise<string | null> {
  const cfg = loadConfig();
  const tz = getTimezone(chatId) ?? cfg.DEFAULT_TIMEZONE;
  const cc = getChatConfig(chatId);
  if (!cc?.provider_group_id) return null;
  const window = yesterdayWindow(now, tz);
  const text = await buildReportText(
    { provider_name: cc.provider_name, provider_group_id: cc.provider_group_id },
    window,
    tz,
  );
  return humorizeOrOriginal(text);
}

/**
 * Scheduler tick: for every chat with the digest enabled, post the previous
 * day's report once its local target time has passed. Mirrors runDueTasks —
 * called once a minute and self-throttles via the stored last-posted date.
 */
export async function runDailySpendingReports(
  bot: Bot,
  now: number = Date.now(),
): Promise<void> {
  const cfg = loadConfig();
  let chats;
  try {
    chats = listDailySpendingEnabled();
  } catch (err) {
    logger.warn({ err }, 'failed to list daily-spending chats');
    return;
  }

  for (const s of chats) {
    try {
      const tz = getTimezone(s.chatId) ?? cfg.DEFAULT_TIMEZONE;
      const { send, window } = decideDue(now, tz, s);
      if (!send) continue;

      const cc = getChatConfig(s.chatId);
      if (!cc?.provider_group_id) {
        // Enabled but no group linked: nothing to report. Mark the day done so
        // we don't re-check every minute until it's reconnected.
        setDailySpendingLastDate(s.chatId, window.reportDate);
        continue;
      }

      const text = await buildReportText(
        { provider_name: cc.provider_name, provider_group_id: cc.provider_group_id },
        window,
        tz,
      );
      const finalText = await humorizeOrOriginal(text);
      await sendMarkdown(bot, s.chatId, finalText);
      // Only mark done after a successful post, so a transient provider error
      // retries on the next tick rather than silently skipping the day.
      setDailySpendingLastDate(s.chatId, window.reportDate);
    } catch (err) {
      logger.warn({ err, chatId: s.chatId }, 'daily spending report failed');
    }
  }
}
