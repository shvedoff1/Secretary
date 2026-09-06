import type { Bot } from 'grammy';
import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import {
  dueFlightWatches,
  setFlightCheckResult,
  disableFlightWatch,
  type FlightWatch,
} from '../db/repos/flightWatch.repo.js';
import { addTurn, pruneOld } from '../db/repos/conversation.repo.js';
import { recordChatLog } from '../bot/chatLog.js';
import { fetchFlightStatuses, flightFeedConfigured } from './feed.js';
import {
  adaptivePollMinutes,
  diffSnapshots,
  describeChanges,
  isTerminalChange,
  pickSnapshot,
  renderFlightCard,
  statusRu,
  type FlightSnapshot,
} from './status.js';

// After this many consecutive feed failures the chat gets ONE heads-up (the
// watch keeps trying until it expires) — same discipline as page watches.
const FAIL_NOTIFY_COUNT = 10;

// How much of the feed's error reaches the chat and the /flight list. The
// message is the diagnosis («AeroDataBox HTTP 400: date out of range», a
// timeout, a spent quota) — without it the warning could only say «не могу»,
// and the cause lived in the process log alone.
const ERROR_MAX_CHARS = 200;

/** One-line, bounded description of a feed failure (pure; exported for tests). */
export function describeFeedError(err: unknown): string {
  const raw =
    err instanceof Error
      ? err.name === 'TimeoutError' || err.name === 'AbortError'
        ? `таймаут запроса (${err.message || err.name})`
        : err.message || err.name
      : String(err);
  const line = raw.replace(/\s+/g, ' ').trim() || 'unknown error';
  return line.length > ERROR_MAX_CHARS ? `${line.slice(0, ERROR_MAX_CHARS - 1)}…` : line;
}

/**
 * Failures that will NOT go away on their own, so the chat is told on the
 * FIRST hit rather than after the usual streak: auth (bad key / dead
 * subscription — 401/403) and quota (402 payment required / 429 too many
 * requests — a monthly allowance spent means every poll until the reset
 * fails the same way). Pure; exported for tests.
 */
export function permanentFailureKind(err: unknown): 'auth' | 'quota' | null {
  if (!(err instanceof Error)) return null;
  if (/HTTP 40[13]\b/.test(err.message)) return 'auth';
  if (/HTTP (402|429)\b/.test(err.message)) return 'quota';
  return null;
}

async function notify(bot: Bot, chatId: number, text: string): Promise<void> {
  await bot.api.sendMessage(chatId, text, { link_preview_options: { is_disabled: true } });
}

/** Post a change/status notification and record it as chat context (like page watches). */
async function notifyAndRecord(bot: Bot, chatId: number, text: string): Promise<void> {
  const cfg = loadConfig();
  await notify(bot, chatId, text);
  // Record what was posted as an assistant turn so a follow-up in the chat
  // («а во сколько теперь вылет?») has the context it refers to.
  addTurn({ chatId, role: 'assistant', tgUserId: null, content: text });
  recordChatLog({ chatId, role: 'assistant', tgUserId: null, content: text });
  pruneOld(chatId, cfg.CONVERSATION_HISTORY_LIMIT * 2);
}

async function checkFlightWatch(bot: Bot, watch: FlightWatch): Promise<void> {
  const cfg = loadConfig();
  const now = Date.now();

  // Expiry first: a flight long gone must not poll (and burn feed quota) forever.
  if (now >= watch.expiresAt) {
    disableFlightWatch(watch.id);
    await notify(
      bot,
      watch.chatId,
      `⏳ Слежка #${watch.id} «${watch.title}» — время вышло, снял наблюдение за рейсом ${watch.flight}. Нужно ещё — просто попроси заново.`,
    );
    return;
  }

  // Poll pace is ADAPTIVE (rare news far out, tight near departure) and follows
  // the freshest snapshot each path has — a reschedule moves the fast window.
  const nextCheckAfter = (snap: FlightSnapshot | null): number =>
    now + adaptivePollMinutes(snap, watch.flightDate, now, watch.intervalMinutes) * 60_000;

  let snapshots: FlightSnapshot[];
  try {
    snapshots = await fetchFlightStatuses(watch.flight, watch.flightDate);
  } catch (err) {
    const failCount = watch.failCount + 1;
    const lastError = describeFeedError(err);
    logger.warn(
      { err, watchId: watch.id, flight: watch.flight, date: watch.flightDate, failCount },
      'flight watch fetch failed',
    );
    setFlightCheckResult(watch.id, {
      nextCheckAt: nextCheckAfter(watch.lastSnapshot),
      lastCheckedAt: now,
      lastSnapshot: watch.lastSnapshot,
      failCount,
      lastError,
    });
    // An auth/quota failure (bad key, dead subscription, spent allowance) is
    // PERMANENT — waiting out the usual 10-failure streak would let a short
    // watch (armed a few hours before a flight) die in silence, so it warns on
    // the FIRST hit. Transient errors keep the once-at-the-threshold
    // discipline. Either way the warning carries the feed's own answer: that
    // is the diagnosis, and it must not live in the process log alone.
    const permanent = permanentFailureKind(err);
    if (permanent ? failCount === 1 : failCount === FAIL_NOTIFY_COUNT) {
      const reason =
        permanent === 'auth'
          ? `источник данных не пускает (похоже, проблема с API-ключом/подпиской): ${lastError}`
          : permanent === 'quota'
            ? `источник данных отвечает, что лимит запросов исчерпан (тариф/квота): ${lastError}`
            : `не могу получить данные по рейсу ${watch.flight}${watch.flightDate ? ` на ${watch.flightDate}` : ''} (уже ${failCount} попыток подряд; последний ответ: ${lastError})`;
      await notify(
        bot,
        watch.chatId,
        `⚠️ Слежка #${watch.id} «${watch.title}»: ${reason}. Продолжаю пытаться. Снять: /flight del ${watch.id}`,
      );
    }
    return;
  }

  const next = pickSnapshot(snapshots, watch.flightDate, now);
  if (!next) {
    // The feed answered but doesn't cover the watched date yet (it publishes
    // flights near their day) — not a failure, just nothing to compare yet.
    setFlightCheckResult(watch.id, {
      nextCheckAt: nextCheckAfter(null),
      lastCheckedAt: now,
      lastSnapshot: watch.lastSnapshot,
      failCount: 0,
    });
    return;
  }

  const prev = watch.lastSnapshot;
  if (!prev) {
    // First data: this is the baseline. A flight that is ALREADY cancelled (or
    // over) when the watch first sees it is still the awaited news — deliver it
    // now instead of staying silent forever waiting for a "change".
    if (next.status === 'cancelled' || next.status === 'landed') {
      const headline =
        next.status === 'cancelled'
          ? `🚨 «${watch.title}»: рейс ${watch.flight} ОТМЕНЁН.`
          : `🛬 «${watch.title}»: рейс ${watch.flight} уже ${statusRu(next.status)}.`;
      // Notify FIRST, then disarm: if the send throws, the outer catch
      // reschedules the poll and the news is re-announced next cycle.
      await notifyAndRecord(bot, watch.chatId, `${headline}\n\n${renderFlightCard(next)}`);
      disableFlightWatch(watch.id, now);
      return;
    }
    setFlightCheckResult(watch.id, {
      nextCheckAt: nextCheckAfter(next),
      lastCheckedAt: now,
      lastSnapshot: next,
      failCount: 0,
    });
    return;
  }

  const changes = diffSnapshots(prev, next, cfg.FLIGHT_DELAY_NOTIFY_MINUTES);
  if (changes.length === 0) {
    // Keep the OLD baseline: small under-threshold moves must accumulate until
    // they cross the threshold, not be silently re-baselined every poll.
    // Pacing still reads the NEW snapshot — the freshest departure estimate.
    setFlightCheckResult(watch.id, {
      nextCheckAt: nextCheckAfter(next),
      lastCheckedAt: now,
      lastSnapshot: prev,
      failCount: 0,
    });
    return;
  }

  const text = [
    `✈️ «${watch.title}» — рейс ${watch.flight}:`,
    ...describeChanges(changes),
    '',
    renderFlightCard(next),
  ].join('\n');
  // Notify FIRST, then persist: a failed send leaves the old baseline in place,
  // so the same change is re-detected and re-announced on the next poll.
  await notifyAndRecord(bot, watch.chatId, text);

  if (changes.some(isTerminalChange)) {
    disableFlightWatch(watch.id, now);
  } else {
    setFlightCheckResult(watch.id, {
      nextCheckAt: nextCheckAfter(next),
      lastCheckedAt: now,
      lastSnapshot: next,
      failCount: 0,
    });
  }
}

/** Poll every flight watch whose next check is due. Called from the minute tick in index.ts. */
export async function runDueFlightWatches(bot: Bot): Promise<void> {
  if (!flightFeedConfigured()) return;
  let watches: FlightWatch[];
  try {
    watches = dueFlightWatches(Date.now());
  } catch (err) {
    logger.warn({ err }, 'failed to query due flight watches');
    return;
  }
  for (const watch of watches) {
    try {
      await checkFlightWatch(bot, watch);
    } catch (err) {
      // Belt and braces: checkFlightWatch handles feed errors itself, so this is
      // for the unexpected (Telegram send failing etc.). Push the next check out
      // so a poisoned watch can't spin on every tick.
      logger.error({ err, watchId: watch.id }, 'flight watch check failed');
      try {
        setFlightCheckResult(watch.id, {
          nextCheckAt: Date.now() + watch.intervalMinutes * 60_000,
          lastCheckedAt: Date.now(),
          lastSnapshot: watch.lastSnapshot,
          failCount: watch.failCount + 1,
          lastError: describeFeedError(err),
        });
      } catch {
        /* nothing more we can do */
      }
    }
  }
}
