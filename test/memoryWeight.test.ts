import { describe, it, expect } from 'vitest';
import {
  effectiveWeight,
  selectForContext,
  selectForPrune,
  PINNED_FLOOR,
  type WeightedItem,
} from '../src/util/memoryWeight.js';

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;
const HALF = 14;

function item(over: Partial<WeightedItem>): WeightedItem {
  return {
    id: 1,
    scope: 'chat',
    tgUserId: null,
    subject: '',
    content: 'c',
    importance: 3,
    reinforce: 0,
    source: 'passive',
    lastSeen: NOW,
    ...over,
  };
}

describe('effectiveWeight decay', () => {
  it('decreases monotonically as a fact ages', () => {
    const fresh = effectiveWeight(item({ lastSeen: NOW }), NOW, HALF);
    const old = effectiveWeight(item({ lastSeen: NOW - 14 * DAY }), NOW, HALF);
    const older = effectiveWeight(item({ lastSeen: NOW - 28 * DAY }), NOW, HALF);
    expect(fresh).toBeGreaterThan(old);
    expect(old).toBeGreaterThan(older);
  });

  it('halves exactly every half-life', () => {
    const fresh = effectiveWeight(item({ importance: 4, lastSeen: NOW }), NOW, HALF);
    const oneHalfLife = effectiveWeight(
      item({ importance: 4, lastSeen: NOW - 14 * DAY }),
      NOW,
      HALF,
    );
    expect(oneHalfLife).toBeCloseTo(fresh / 2, 6);
  });

  it('reinforcement raises weight with diminishing returns', () => {
    const w = (r: number) => effectiveWeight(item({ reinforce: r }), NOW, HALF);
    expect(w(1)).toBeGreaterThan(w(0));
    const inc1 = w(1) - w(0);
    const inc2 = w(2) - w(1);
    expect(inc2).toBeGreaterThan(0);
    expect(inc2).toBeLessThan(inc1);
  });

  it('pinned/explicit facts beat any decayed passive fact regardless of age', () => {
    const ancientPinned = effectiveWeight(
      item({ source: 'explicit', importance: 1, lastSeen: NOW - 9999 * DAY }),
      NOW,
      HALF,
    );
    const freshTopPassive = effectiveWeight(
      item({ source: 'passive', importance: 5, reinforce: 50, lastSeen: NOW }),
      NOW,
      HALF,
    );
    expect(ancientPinned).toBeGreaterThan(freshTopPassive);
    expect(ancientPinned).toBeGreaterThan(PINNED_FLOOR);
  });
});

describe('selectForContext', () => {
  const SENDER = 100;
  const OTHER = 200;
  const ABSENT = 300;

  const items: WeightedItem[] = [
    item({ id: 1, scope: 'chat', importance: 5, content: 'A' }),
    item({ id: 2, scope: 'chat', importance: 4, content: 'B' }),
    item({ id: 3, scope: 'chat', importance: 3, content: 'C' }),
    item({ id: 10, scope: 'user', tgUserId: SENDER, subject: 'Sky', importance: 5, content: 'U1' }),
    item({ id: 11, scope: 'user', tgUserId: SENDER, subject: 'Sky', importance: 2, content: 'U2' }),
    item({ id: 20, scope: 'user', tgUserId: OTHER, subject: 'Max', importance: 4, content: 'O1' }),
    item({ id: 30, scope: 'user', tgUserId: ABSENT, subject: 'Joe', importance: 4, content: 'X' }),
    item({ id: 40, scope: 'user', tgUserId: null, subject: 'Ghost', importance: 4, content: 'N' }),
  ];

  const sel = selectForContext(items, {
    now: NOW,
    halfLifeDays: HALF,
    senderTgUserId: SENDER,
    recentParticipantIds: [SENDER, OTHER],
    chatBudget: 2,
    userBudget: 1,
  });

  it('returns the top-N chat facts by weight', () => {
    expect(sel.chat.map((i) => i.content)).toEqual(['A', 'B']);
  });

  it('puts the sender first, capped by the user budget', () => {
    expect(sel.users[0]!.tgUserId).toBe(SENDER);
    expect(sel.users[0]!.items.map((i) => i.content)).toEqual(['U1']);
  });

  it('includes recently-active other participants but not absent or unkeyed ones', () => {
    const ids = sel.users.map((u) => u.tgUserId);
    expect(ids).toContain(OTHER);
    expect(ids).not.toContain(ABSENT);
    expect(ids).not.toContain(null);
  });
});

describe('selectForPrune', () => {
  it('keeps the cap of passive items and never drops explicit ones', () => {
    const items: WeightedItem[] = [
      item({ id: 1, importance: 5 }),
      item({ id: 2, importance: 4 }),
      item({ id: 3, importance: 3 }),
      item({ id: 4, importance: 2 }),
      item({ id: 5, importance: 1 }),
      item({ id: 9, source: 'explicit', importance: 1, lastSeen: NOW - 999 * DAY }),
    ];
    const toDelete = selectForPrune(items, 2, NOW, HALF);
    // 5 passive, cap 2 → 3 deleted; the 3 lowest-weight; explicit exempt.
    expect(toDelete.sort()).toEqual([3, 4, 5]);
    expect(toDelete).not.toContain(9);
  });

  it('deletes nothing when under the cap', () => {
    const items = [item({ id: 1 }), item({ id: 2 })];
    expect(selectForPrune(items, 5, NOW, HALF)).toEqual([]);
  });
});
