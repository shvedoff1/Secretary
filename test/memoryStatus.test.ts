import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  effectiveWeight,
  STATUS_HALFLIFE_DIVISOR,
  type WeightedItem,
} from '../src/util/memoryWeight.js';
import { parseMemoryJson } from '../src/llm/memory.js';

// Status facts («сейчас во Вьетнаме»): true now, wrong later — so they decay on a
// much shorter half-life and are hard-expired from the store, while traits keep
// the old behaviour untouched.

const DAY = 86_400_000;

function item(partial: Partial<WeightedItem>): WeightedItem {
  return {
    id: 1,
    scope: 'user',
    tgUserId: 10,
    subject: 'Гоша',
    content: 'x',
    importance: 3,
    reinforce: 0,
    source: 'passive',
    lastSeen: 0,
    ...partial,
  };
}

describe('status decay', () => {
  it('fades a status several times faster than a trait', () => {
    const now = 7 * DAY;
    const trait = effectiveWeight(item({ kind: 'trait' }), now, 14);
    const status = effectiveWeight(item({ kind: 'status' }), now, 14);
    expect(status).toBeLessThan(trait);
    // Half-life 14/5 = 2.8 days → after a week a status keeps well under a quarter.
    expect(status / trait).toBeLessThan(0.3);
    expect(STATUS_HALFLIFE_DIVISOR).toBeGreaterThan(1);
  });

  it('treats a missing kind as trait (pre-migration rows, fixtures)', () => {
    const now = 7 * DAY;
    expect(effectiveWeight(item({}), now, 14)).toBe(
      effectiveWeight(item({ kind: 'trait' }), now, 14),
    );
  });

  it('never decays a pinned fact, whatever its kind', () => {
    const now = 365 * DAY;
    const w = effectiveWeight(item({ source: 'explicit', kind: 'status' }), now, 14);
    expect(w).toBeGreaterThan(1000);
  });
});

describe('extractor kind classification', () => {
  it('parses the kind and defaults anything unclear to trait', () => {
    const out = parseMemoryJson(
      JSON.stringify({
        newItems: [
          { scope: 'user', subject: 'Гоша', content: 'сейчас во Вьетнаме', importance: 3, kind: 'status' },
          { scope: 'user', subject: 'Гоша', content: 'серфит', importance: 3, kind: 'trait' },
          { scope: 'chat', subject: '', content: 'едут в Далат', importance: 3 },
          { scope: 'chat', subject: '', content: 'x', importance: 3, kind: 'nonsense' },
        ],
        reinforcedIds: [],
      }),
    );
    expect(out.newItems.map((i) => i.kind)).toEqual(['status', 'trait', 'trait', 'trait']);
  });
});

describe('status storage and expiry', () => {
  async function fresh() {
    process.env.BOT_TOKEN = 'x';
    process.env.ANTHROPIC_API_KEY = 'x';
    process.env.ADMIN_TELEGRAM_ID = '1';
    process.env.DATABASE_PATH = ':memory:';
    vi.resetModules();
    const { migrate } = await import('../src/db/migrate.js');
    migrate();
    return import('../src/db/repos/memoryItem.repo.js');
  }

  let closeDb: () => void;
  beforeEach(async () => {
    ({ closeDb } = await import('../src/db/client.js'));
  });
  afterEach(() => {
    if (closeDb) closeDb();
  });

  it('stores the kind and shows it in the display list', async () => {
    const repo = await fresh();
    repo.recordMemoryItems(1, [
      { scope: 'user', tgUserId: 10, subject: 'Гоша', content: 'сейчас во Вьетнаме', importance: 3, kind: 'status' },
      { scope: 'user', tgUserId: 10, subject: 'Гоша', content: 'серфит', importance: 3 },
    ]);
    const items = repo.getAllItems(1);
    expect(items.find((i) => i.content === 'сейчас во Вьетнаме')?.kind).toBe('status');
    expect(items.find((i) => i.content === 'серфит')?.kind).toBe('trait');
    const shown = repo.listMemoryItemsForDisplay(1, 14);
    expect(shown.find((i) => i.content === 'сейчас во Вьетнаме')?.status).toBe(true);
    expect(shown.find((i) => i.content === 'серфит')?.status).toBe(false);
  });

  it('expires only stale passive statuses', async () => {
    const repo = await fresh();
    repo.recordMemoryItems(1, [
      { scope: 'user', tgUserId: 10, subject: 'Гоша', content: 'старый статус', importance: 3, kind: 'status' },
      { scope: 'user', tgUserId: 10, subject: 'Гоша', content: 'свежий статус', importance: 3, kind: 'status' },
      { scope: 'user', tgUserId: 10, subject: 'Гоша', content: 'старый трейт', importance: 3 },
    ]);
    const old = Date.now() - 90 * 86_400_000;
    const { getDb } = await import('../src/db/client.js');
    getDb()
      .prepare(`UPDATE chat_memory_item SET last_seen = ? WHERE content IN ('старый статус', 'старый трейт')`)
      .run(old);
    // A pinned status (edge case) must survive too.
    getDb()
      .prepare(`UPDATE chat_memory_item SET source = 'explicit' WHERE content = 'старый трейт'`)
      .run();

    const removed = repo.expireStatuses(1, 60);
    expect(removed).toBe(1);
    const left = repo.getAllItems(1).map((i) => i.content).sort();
    expect(left).toEqual(['свежий статус', 'старый трейт']);
  });
});
