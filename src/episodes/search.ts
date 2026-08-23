// Pure relevance ranking over the conversation journal — the episodic half of
// the recall_memory deep tier. Reuses the memory search scorer (same tokenizer,
// same exact > prefix > stem ladder) over an episode's notes + topic tags, so a
// query behaves the same against a remembered fact and a remembered conversation.
// Like memory search, relevance is primary; recency only breaks ties — the whole
// point of the deep tier is surfacing the OLD session that actually answers.

import type { ChatEpisode } from '../db/repos/episode.repo.js';
import { scoreItem, tokenize } from '../util/memorySearch.js';

export interface EpisodeHit {
  episode: ChatEpisode;
  score: number;
  matched: number;
}

export function searchEpisodes(
  episodes: readonly ChatEpisode[],
  query: string,
  opts: { limit: number },
): EpisodeHit[] {
  const queryTokens = [...new Set(tokenize(query))];
  if (queryTokens.length === 0) return [];
  const hits: EpisodeHit[] = [];
  for (const episode of episodes) {
    const scored = scoreItem(queryTokens, `${episode.summary} ${episode.topics.join(' ')}`);
    if (scored) hits.push({ episode, score: scored.score, matched: scored.matched });
  }
  hits.sort((a, b) => {
    if (b.matched !== a.matched) return b.matched - a.matched;
    if (b.score !== a.score) return b.score - a.score;
    if (b.episode.endedAt !== a.episode.endedAt) return b.episode.endedAt - a.episode.endedAt;
    return a.episode.id - b.episode.id; // stable: same query, same order
  });
  return hits.slice(0, opts.limit);
}
