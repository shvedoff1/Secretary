import type { Bot } from 'grammy';
import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import {
  dueWatches,
  setCheckResult,
  disableWatch,
  type PageWatch,
} from '../db/repos/pageWatch.repo.js';
import { addTurn, pruneOld } from '../db/repos/conversation.repo.js';
import { fetchPageHtml } from './fetch.js';
import { findKeywords, buildExcerpt, hashText } from './extract.js';
import { checkWatchCondition } from '../llm/watchCheck.js';

// After this many consecutive fetch failures the chat gets ONE heads-up that the
// page can't be opened (the watch keeps trying until it expires). Announcing at
// an exact count keeps it a single message, not a nag on every failed poll.
const FAIL_NOTIFY_COUNT = 10;

async function notify(bot: Bot, chatId: number, text: string): Promise<void> {
  await bot.api.sendMessage(chatId, text, { link_preview_options: { is_disabled: true } });
}

async function checkWatch(bot: Bot, watch: PageWatch): Promise<void> {
  const cfg = loadConfig();
  const now = Date.now();

  // Expiry first: a watch that never fired must not poll (and burn checks)
  // forever — disarm with a note so the user knows the tail went quiet.
  if (now >= watch.expiresAt) {
    disableWatch(watch.id);
    await notify(
      bot,
      watch.chatId,
      `⏳ Вотчер #${watch.id} «${watch.title}» — время вышло, событие так и не появилось. Снял слежку с ${watch.url}. Нужно ещё — просто попроси заново.`,
    );
    return;
  }

  const nextCheckAt = now + watch.intervalMinutes * 60_000;

  let html: string;
  try {
    html = await fetchPageHtml(watch.url);
  } catch (err) {
    const failCount = watch.failCount + 1;
    logger.warn({ err, watchId: watch.id, failCount }, 'watch fetch failed');
    setCheckResult(watch.id, {
      nextCheckAt,
      lastCheckedAt: now,
      lastHash: watch.lastHash,
      failCount,
    });
    if (failCount === FAIL_NOTIFY_COUNT) {
      await notify(
        bot,
        watch.chatId,
        `⚠️ Вотчер #${watch.id} «${watch.title}»: не могу открыть ${watch.url} (уже ${failCount} попыток подряд). Продолжаю пытаться. Снять: /watch del ${watch.id}`,
      );
    }
    return;
  }

  // Keyword gate: the awaited thing isn't even mentioned => the event can't have
  // happened, no LLM needed. lastHash resets so the first keyword appearance
  // always triggers a real check.
  const hits = findKeywords(html, watch.keywords);
  if (hits.length === 0) {
    setCheckResult(watch.id, { nextCheckAt, lastCheckedAt: now, lastHash: null, failCount: 0 });
    return;
  }

  // Unchanged since the last evaluated poll => the verdict can't have changed;
  // skip the model call (this is what makes frequent polling cheap).
  const excerpt = buildExcerpt(html, watch.keywords);
  const hash = hashText(excerpt);
  if (hash === watch.lastHash) {
    setCheckResult(watch.id, { nextCheckAt, lastCheckedAt: now, lastHash: hash, failCount: 0 });
    return;
  }

  const verdict = await checkWatchCondition(watch.condition, excerpt);
  if (!verdict.met) {
    setCheckResult(watch.id, { nextCheckAt, lastCheckedAt: now, lastHash: hash, failCount: 0 });
    return;
  }

  // Notify FIRST, then disarm: if Telegram is down the send throws, the outer
  // catch reschedules the poll and the event is re-announced next cycle — a
  // disarm-first order would swallow the event forever on one failed send.
  const evidence = verdict.evidence ? `\n${verdict.evidence}` : '';
  const posted = `🔔 «${watch.title}» — свершилось!${evidence}\n${watch.url}`;
  await notify(bot, watch.chatId, posted);
  disableWatch(watch.id, now);
  // Mirror the scheduler: record what was posted as an assistant turn so a
  // follow-up in the chat («а во сколько сеансы?») has the context it refers to.
  addTurn({ chatId: watch.chatId, role: 'assistant', tgUserId: null, content: posted });
  pruneOld(watch.chatId, cfg.CONVERSATION_HISTORY_LIMIT * 2);
}

/** Poll every watch whose next check is due. Called from the minute tick in index.ts. */
export async function runDueWatches(bot: Bot): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.ENABLE_WATCH) return;
  let watches: PageWatch[];
  try {
    watches = dueWatches(Date.now());
  } catch (err) {
    logger.warn({ err }, 'failed to query due watches');
    return;
  }
  for (const watch of watches) {
    try {
      await checkWatch(bot, watch);
    } catch (err) {
      // Belt and braces: checkWatch handles fetch errors itself, so this is for
      // the unexpected (Telegram send failing etc.). Push the next check out so
      // a poisoned watch can't spin on every tick.
      logger.error({ err, watchId: watch.id }, 'watch check failed');
      try {
        setCheckResult(watch.id, {
          nextCheckAt: Date.now() + watch.intervalMinutes * 60_000,
          lastCheckedAt: Date.now(),
          lastHash: watch.lastHash,
          failCount: watch.failCount + 1,
        });
      } catch {
        /* nothing more we can do */
      }
    }
  }
}
