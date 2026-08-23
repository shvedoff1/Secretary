// Profile-card refresh, triggered by episode close: "consolidation during rest".
// When a conversation session ends, the cheap model is shown the current cards,
// the session's fresh notes and the chat's top FACTS (ground truth), and returns
// only the cards the session actually changed — omitted cards stay word-for-word,
// a failed call keeps everything as it was. Cards are a derived view over the
// memory store: correcting a fact (remember/edit_memory) fixes the card at the
// next close, and /profile <chatId> clear regenerates from scratch.

import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { getAllItems, type MemoryItem } from '../db/repos/memoryItem.repo.js';
import { listProfiles, upsertProfile } from '../db/repos/profile.repo.js';
import type { ChatEpisode } from '../db/repos/episode.repo.js';
import { effectiveWeight } from '../util/memoryWeight.js';
import { refreshProfileCards } from '../llm/profile.js';

// How many top-weighted facts anchor the rewrite. Same order of magnitude as the
// extractor's known-facts window; a module constant to avoid config sprawl.
const FACT_CONTEXT = 40;

/** Ground-truth line the rewriter sees: who it's about, pinned/status markers. */
export function renderFactLine(item: MemoryItem): string {
  const who = item.scope === 'user' ? item.subject || 'участник' : 'чат';
  const pin = item.source === 'explicit' ? ' 📌' : '';
  const status = item.kind === 'status' ? ' (статус)' : '';
  return `[${who}]${pin}${status} ${item.content}`;
}

/**
 * Refresh a chat's profile cards from just-closed episodes. Best-effort by
 * design: any failure is logged and swallowed — the episodes are already stored,
 * and stale cards beat no episode close.
 */
export async function refreshProfilesForChat(
  chatId: number,
  episodes: ChatEpisode[],
): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.ENABLE_PROFILES || !cfg.ENABLE_MEMORY || episodes.length === 0) return;
  try {
    const now = Date.now();
    const facts = getAllItems(chatId)
      // Voice/style directives aren't portrait material — they describe how the
      // BOT talks, and on a card they'd read as facts about the people.
      .filter((i) => i.scope !== 'persona')
      .sort(
        (a, b) =>
          effectiveWeight(b, now, cfg.MEMORY_HALFLIFE_DAYS) -
          effectiveWeight(a, now, cfg.MEMORY_HALFLIFE_DAYS),
      )
      .slice(0, FACT_CONTEXT)
      .map(renderFactLine);
    const cards = listProfiles(chatId).map((c) => ({ subject: c.subject, content: c.content }));
    const notes = episodes.map((e) =>
      e.topics.length > 0 ? `${e.summary}\n(темы: ${e.topics.join(', ')})` : e.summary,
    );

    const drafts = await refreshProfileCards({ cards, episodeNotes: notes, facts });
    if (!drafts || drafts.length === 0) return; // failure or nothing changed → old cards stand
    for (const d of drafts) upsertProfile(chatId, d.subject, d.content);
    logger.info(
      { chatId, updated: drafts.map((d) => d.subject || '(chat)') },
      'profile cards refreshed',
    );
  } catch (err) {
    logger.warn({ err, chatId }, 'profile refresh failed');
  }
}
