// Pure weight/decay math for the chat memory store. No DB, no I/O — so it can be
// unit-tested in isolation and reused by both the read path (what to inject into
// context) and the prune path (what to forget when over the volume cap).

/** The minimal shape the weight math needs (a subset of a stored memory item). */
export interface WeightedItem {
  id: number;
  scope: 'chat' | 'user';
  tgUserId: number | null;
  subject: string;
  content: string;
  importance: number;
  reinforce: number;
  source: 'passive' | 'explicit';
  /** Unix ms of the last time this fact was seen/reinforced (decay is measured from here). */
  lastSeen: number;
}

// Each re-mention adds a diminishing bonus, so a fact that keeps coming up grows in
// weight but a spammed phrase can't dominate forever.
export const REINFORCE_BONUS = 0.5;
// Explicit ("remember") facts are pinned: this floor lifts them above any decayed
// passive item, so they always survive pruning and always reach the context.
export const PINNED_FLOOR = 1000;
// Salience scale the extractor uses, and the step a re-mention nudges importance by.
export const MAX_IMPORTANCE = 5;
export const MIN_IMPORTANCE = 1;
export const REINFORCE_IMPORTANCE_STEP = 0.5;

const DAY_MS = 86_400_000;

/**
 * Effective weight of a memory item right now: base salience (importance plus a
 * diminishing reinforcement bonus) multiplied by an exponential time-decay that
 * halves every `halfLifeDays`. Explicit/pinned items skip decay and sit above the
 * floor so they always win. Higher = more worth keeping/showing.
 */
export function effectiveWeight(item: WeightedItem, now: number, halfLifeDays: number): number {
  const base = item.importance + REINFORCE_BONUS * Math.log1p(Math.max(0, item.reinforce));
  if (item.source === 'explicit') return base + PINNED_FLOOR;
  const ageDays = Math.max(0, (now - item.lastSeen) / DAY_MS);
  const decay = Math.pow(2, -ageDays / halfLifeDays);
  return base * decay;
}

export interface ContextBudgets {
  now: number;
  halfLifeDays: number;
  senderTgUserId: number;
  /** Other tg user ids active in the recent conversation (sender may be included; it's filtered out). */
  recentParticipantIds: number[];
  /** Max shared chat-scope facts to inject. */
  chatBudget: number;
  /** Max facts about the current sender to inject. */
  userBudget: number;
  /** Max facts to inject per OTHER recently-active participant (default 1). */
  otherUserBudget?: number;
  /** Max number of other participants to include (default 4). */
  maxOtherUsers?: number;
}

export interface UserMemoryGroup {
  tgUserId: number;
  subject: string;
  items: WeightedItem[];
}

export interface ContextSelection {
  chat: WeightedItem[];
  /** Sender first, then other recently-active participants ordered by their top fact's weight. */
  users: UserMemoryGroup[];
}

function byWeightDesc(now: number, halfLifeDays: number) {
  return (a: WeightedItem, b: WeightedItem): number =>
    effectiveWeight(b, now, halfLifeDays) - effectiveWeight(a, now, halfLifeDays);
}

/**
 * Pick the tight working set to inject into the LLM context: the top shared chat
 * facts, the top facts about the current sender, and a fact or two about each other
 * recently-active participant — all by effective weight, within the given budgets.
 */
export function selectForContext(items: WeightedItem[], b: ContextBudgets): ContextSelection {
  const cmp = byWeightDesc(b.now, b.halfLifeDays);
  const otherBudget = b.otherUserBudget ?? 1;
  const maxOthers = b.maxOtherUsers ?? 4;

  const chat = items
    .filter((i) => i.scope === 'chat')
    .sort(cmp)
    .slice(0, b.chatBudget);

  const userItems = items.filter((i) => i.scope === 'user' && i.tgUserId !== null);

  const sender = userItems
    .filter((i) => i.tgUserId === b.senderTgUserId)
    .sort(cmp)
    .slice(0, b.userBudget);

  const users: UserMemoryGroup[] = [];
  if (sender.length > 0) {
    users.push({ tgUserId: b.senderTgUserId, subject: sender[0]!.subject, items: sender });
  }

  // Other participants currently in the conversation: one (or a few) facts each.
  const others = new Map<number, WeightedItem[]>();
  for (const item of userItems) {
    const uid = item.tgUserId!;
    if (uid === b.senderTgUserId) continue;
    if (!b.recentParticipantIds.includes(uid)) continue;
    const bucket = others.get(uid);
    if (bucket) bucket.push(item);
    else others.set(uid, [item]);
  }
  const otherGroups: UserMemoryGroup[] = [];
  for (const [uid, list] of others) {
    const top = list.sort(cmp).slice(0, otherBudget);
    if (top.length > 0) otherGroups.push({ tgUserId: uid, subject: top[0]!.subject, items: top });
  }
  // Strongest other participants first; cap how many we include.
  otherGroups.sort((a, c) => cmp(a.items[0]!, c.items[0]!));
  users.push(...otherGroups.slice(0, maxOthers));

  return { chat, users };
}

/**
 * Decide which passive items to forget to keep storage within `max`. Explicit/pinned
 * items are exempt from the cap; among passive items, the lowest-weight ones beyond
 * the cap are returned for deletion. Returns the ids to delete.
 */
export function selectForPrune(
  items: WeightedItem[],
  max: number,
  now: number,
  halfLifeDays: number,
): number[] {
  const passive = items.filter((i) => i.source !== 'explicit');
  if (passive.length <= max) return [];
  const ranked = [...passive].sort(byWeightDesc(now, halfLifeDays));
  return ranked.slice(max).map((i) => i.id);
}
