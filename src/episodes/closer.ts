// The episode close pass, driven by the minute tick in index.ts (same heartbeat
// as the scheduler and the watch poller). Each tick it looks for chats whose log
// holds messages newer than their episode watermark, re-derives session
// boundaries from the timestamps (segmentEpisodes — durable, no in-memory
// timers), and closes every finished session: render its transcript, compress it
// with the cheap model into notes + topics, store the episode. The active tail of
// a conversation is never touched, and a failed model call leaves the session
// unclosed so nothing is lost — it just retries after a backoff.

import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { readLog } from '../db/repos/chatLog.repo.js';
import {
  episodeCandidates,
  insertEpisode,
  pruneEpisodes,
} from '../db/repos/episode.repo.js';
import { getTimezone } from '../db/repos/chatSettings.repo.js';
import { renderTranscript } from '../summary/transcript.js';
import { summarizeEpisode } from '../llm/episode.js';
import { segmentEpisodes } from './detect.js';

// Chats whose last close attempt failed wait this long before retrying, so a
// broken API key doesn't turn the minute tick into a call-per-minute loop.
const retryAt = new Map<number, number>();

/** Test seam: forget the failure backoff state. */
export function resetEpisodeBackoff(): void {
  retryAt.clear();
}

/**
 * Close every finished conversation session across all chats. Called once a
 * minute; cheap when idle (one grouped query), and each actual close costs one
 * cheap-model call. Chats are processed sequentially — this is a background pass,
 * fanning it out would only burn rate limit.
 */
export async function runDueEpisodes(now = Date.now()): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.ENABLE_EPISODES || !cfg.ENABLE_CHAT_LOG) return;

  const quietMs = cfg.EPISODE_QUIET_MINUTES * 60_000;
  for (const cand of episodeCandidates()) {
    const wait = retryAt.get(cand.chatId);
    if (wait !== undefined && now < wait) continue;
    // Cheap pre-filter: a chat still mid-conversation with no earlier gap can be
    // skipped without reading its log at all only when its NEWEST message is
    // fresh AND everything unclosed fits one session — we can't know the latter
    // without reading, so only skip the trivial "just spoke seconds ago and the
    // unclosed span is shorter than one quiet gap" case.
    if (now - cand.newestAt < quietMs && cand.newestAt - cand.watermark < quietMs) continue;
    try {
      await closeChatEpisodes(cand.chatId, cand.watermark, now);
      retryAt.delete(cand.chatId);
    } catch (err) {
      logger.warn({ err, chatId: cand.chatId }, 'episode close failed');
      retryAt.set(cand.chatId, now + cfg.EPISODE_RETRY_MINUTES * 60_000);
    }
  }
}

async function closeChatEpisodes(chatId: number, watermark: number, now: number): Promise<void> {
  const cfg = loadConfig();
  const messages = readLog(chatId, {
    limit: cfg.EPISODE_MAX_MESSAGES,
    fromMs: watermark + 1,
  });
  if (messages.length === 0) return;
  // readLog keeps the NEWEST `limit` of the range; anything older than the read
  // window will fall behind the watermark once these close. State it once.
  if (messages.length === cfg.EPISODE_MAX_MESSAGES) {
    logger.info(
      { chatId, cap: cfg.EPISODE_MAX_MESSAGES },
      'episode backlog exceeds read cap; oldest unclosed messages will be skipped',
    );
  }

  const segments = segmentEpisodes(
    messages.map((m) => m.createdAt),
    { now, quietMs: cfg.EPISODE_QUIET_MINUTES * 60_000, minMessages: cfg.EPISODE_MIN_MESSAGES },
  );
  if (segments.length === 0) return;

  const tz = getTimezone(chatId) ?? cfg.DEFAULT_TIMEZONE;
  for (const seg of segments.slice(0, cfg.EPISODE_MAX_PER_TICK)) {
    const slice = messages.slice(seg.start, seg.end + 1);
    const rendered = renderTranscript(slice, { tz, charBudget: cfg.EPISODE_CHAR_BUDGET });
    const head =
      rendered.dropped > 0
        ? `(начало сессии — ${rendered.dropped} сообщ. — не поместилось и не показано)\n`
        : '';
    const notes = await summarizeEpisode(`${head}${rendered.text}`);
    if (!notes) {
      // Do NOT advance past an unsummarised stretch: closing later segments first
      // would move the watermark over this one and silently lose it.
      throw new Error('episode summarisation returned nothing');
    }
    insertEpisode({
      chatId,
      startedAt: slice[0]!.createdAt,
      endedAt: slice[slice.length - 1]!.createdAt,
      messageCount: slice.length,
      summary: notes.summary,
      topics: notes.topics,
    });
    logger.info(
      { chatId, messages: slice.length, topics: notes.topics },
      'episode closed',
    );
  }
  pruneEpisodes(chatId, cfg.EPISODE_KEEP_PER_CHAT);
}
