// Pure relevance ranking for the memory store. No DB, no I/O — the read path for
// the `recall_memory` tool, mirroring how memoryWeight.ts holds the decay math.
//
// Why not FTS5: a chat's memory is hundreds (now thousands) of SHORT rows that are
// inserted, reinforced, edited and pruned constantly. An external-content FTS index
// would have to be kept in sync through every one of those paths, and a drifted
// index silently returns wrong facts. Scoring a few thousand short strings in JS is
// microseconds, needs no migration, and can never drift from the rows.

import { effectiveWeight, normalizeForDedup, type WeightedItem } from './memoryWeight.js';

/** Tokens shorter than this carry no signal ("в", "и", "на"). */
const MIN_TOKEN = 3;
/** Query tokens beyond this are ignored — a paragraph is not a query. */
const MAX_QUERY_TOKENS = 12;

// Scores per matched query token, strongest first. Exact beats prefix beats a shared
// stem, so "серф" finding "серфинг" ranks below a literal "серфинг" hit.
const SCORE_EXACT = 3;
const SCORE_PREFIX = 2;
const SCORE_STEM = 1;
/** Min length for a prefix match, so "про" doesn't match "программа". */
const PREFIX_MIN = 4;
/** Shared leading characters that count as the same word stem («машину»/«машина»). */
const STEM_PREFIX = 5;

/** A hit: the item plus why it ranked where it did. */
export interface MemoryHit<T> {
  item: T;
  /** Summed token score — higher is a better textual match. */
  score: number;
  /** How many distinct query tokens matched at all. */
  matched: number;
}

/**
 * Split text into comparable tokens. Reuses the dedup normalizer so search folds
 * case, ё/е and punctuation exactly the way duplicate detection does — two facts
 * that dedup as equal must also be found by the same query.
 */
export function tokenize(text: string): string[] {
  return normalizeForDedup(text)
    .split(' ')
    .filter((t) => t.length >= MIN_TOKEN);
}

function sharedPrefix(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

/** Best score for one query token against one item token (0 = no match). */
function tokenScore(query: string, candidate: string): number {
  if (query === candidate) return SCORE_EXACT;
  const shorter = Math.min(query.length, candidate.length);
  if (shorter >= PREFIX_MIN && (candidate.startsWith(query) || query.startsWith(candidate))) {
    return SCORE_PREFIX;
  }
  // Russian inflects endings, so an exact/prefix test misses «машину» vs «машина».
  // A shared stem is the weakest signal, deliberately: it is recall, not precision.
  if (sharedPrefix(query, candidate) >= STEM_PREFIX) return SCORE_STEM;
  return 0;
}

/**
 * Score one item against the query tokens: each query token contributes its best
 * match against any of the item's tokens. Returns null when nothing matched, so
 * callers never surface a zero-relevance fact as a "hit".
 */
export function scoreItem(
  queryTokens: readonly string[],
  itemText: string,
): { score: number; matched: number } | null {
  if (queryTokens.length === 0) return null;
  const candidates = tokenize(itemText);
  if (candidates.length === 0) return null;
  let score = 0;
  let matched = 0;
  for (const q of queryTokens) {
    let best = 0;
    for (const c of candidates) {
      const s = tokenScore(q, c);
      if (s > best) best = s;
      if (best === SCORE_EXACT) break;
    }
    if (best > 0) {
      score += best;
      matched++;
    }
  }
  return matched > 0 ? { score, matched } : null;
}

export interface SearchOptions {
  /** Restrict to facts about this person (matched against the item's subject). */
  about?: string | null;
  limit: number;
  now: number;
  halfLifeDays: number;
}

/**
 * Rank a chat's memory items against a free-text query.
 *
 * Relevance is PRIMARY and weight only breaks ties: a decayed two-month-old fact that
 * actually answers the question beats a fresh, heavily-reinforced fact that merely
 * shares a word. That is the whole point of having a searchable tier — the weighted
 * working set already covers "what's salient right now".
 */
export function searchMemory<T extends WeightedItem>(
  items: readonly T[],
  query: string,
  opts: SearchOptions,
): MemoryHit<T>[] {
  const queryTokens = [...new Set(tokenize(query))].slice(0, MAX_QUERY_TOKENS);
  const aboutTokens = opts.about ? tokenize(opts.about) : [];

  const pool = aboutTokens.length > 0
    ? items.filter((i) => scoreItem(aboutTokens, i.subject) !== null)
    : items;

  // With `about` alone ("что я знаю про Гошу") there is nothing to rank by, so fall
  // back to the weighted order — that IS the answer to "what do you know about X".
  if (queryTokens.length === 0) {
    if (aboutTokens.length === 0) return [];
    return [...pool]
      .sort((a, b) => effectiveWeight(b, opts.now, opts.halfLifeDays) - effectiveWeight(a, opts.now, opts.halfLifeDays))
      .slice(0, opts.limit)
      .map((item) => ({ item, score: 0, matched: 0 }));
  }

  const hits: MemoryHit<T>[] = [];
  for (const item of pool) {
    // The subject is part of the searchable text: «когда у Гоши днюха» should find a
    // user-scoped fact whose content never repeats the name.
    const scored = scoreItem(queryTokens, `${item.content} ${item.subject}`);
    if (scored) hits.push({ item, score: scored.score, matched: scored.matched });
  }

  hits.sort((a, b) => {
    if (b.matched !== a.matched) return b.matched - a.matched;
    if (b.score !== a.score) return b.score - a.score;
    const wb = effectiveWeight(b.item, opts.now, opts.halfLifeDays);
    const wa = effectiveWeight(a.item, opts.now, opts.halfLifeDays);
    if (wb !== wa) return wb - wa;
    return a.item.id - b.item.id; // stable: same query, same order
  });
  return hits.slice(0, opts.limit);
}
