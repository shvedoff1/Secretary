// Pure presentation helpers for the conversation journal. The context block and
// the recall tool both show an episode as one line: when it happened, its topic
// tags, and the condensed notes. The ISO date rides along in the label because
// that is what the model needs to replay the period verbatim via summarize_chat
// (its fromDate/toDate take chat-local YYYY-MM-DD).

import type { ChatEpisode } from '../db/repos/episode.repo.js';
import { humanDay } from '../summary/transcript.js';
import { zonedParts } from '../util/day.js';

/** «21 августа (2026-08-21)», or a range when the session crossed midnight. */
export function episodeWhen(ep: Pick<ChatEpisode, 'startedAt' | 'endedAt'>, tz: string): string {
  const from = zonedParts(ep.startedAt, tz).dateStr;
  const to = zonedParts(ep.endedAt, tz).dateStr;
  if (from === to) return `${humanDay(from, tz)} (${from})`;
  return `${humanDay(from, tz)} — ${humanDay(to, tz)} (${from} — ${to})`;
}

/**
 * One journal line for the context block / recall output. The multi-line notes
 * are flattened — a journal entry is a gist, and per-line structure would eat
 * vertical space in a block that is paid for on every turn.
 */
export function renderEpisodeLine(ep: ChatEpisode, tz: string): string {
  const topics = ep.topics.length > 0 ? ` [темы: ${ep.topics.join(', ')}]` : '';
  const notes = ep.summary.replace(/\s*\n+\s*/g, ' • ').trim();
  return `[${episodeWhen(ep, tz)}]${topics} ${notes}`;
}
