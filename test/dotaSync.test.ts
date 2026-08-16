import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DotaSyncState } from '../src/db/repos/dota.repo.js';
import { isSyncDue } from '../src/dota/sync.js';

const OPTS = { hourUtc: 3, minIntervalHours: 20, maxAgeHours: 72, retryIntervalHours: 6 };
const HOUR = 3_600_000;

function at(iso: string): number {
  return Date.parse(iso);
}

function state(over: Partial<DotaSyncState> = {}): DotaSyncState {
  return { patch: '7.41e', lastFullSync: null, lastCheck: null, lastError: null, ...over };
}

describe('isSyncDue', () => {
  it('syncs immediately when the base has never been built', () => {
    // A fresh deploy must not sit unanswerable until 3am.
    expect(isSyncDue(state(), at('2026-08-15T14:00:00Z'), OPTS)).toBe(true);
  });

  it('does not re-crawl every tick while an empty base keeps failing', () => {
    // Regression: the "no data yet" fast path used to bypass the throttle, so a
    // feed outage meant a fresh ~550-request crawl every single hour.
    const now = at('2026-08-15T14:00:00Z');
    const failing = state({ lastFullSync: null, lastCheck: now - HOUR, lastError: 'HTTP 503' });
    expect(isSyncDue(failing, now, OPTS)).toBe(false);
    // ...but it does come back once the retry window is up.
    expect(isSyncDue(failing, now + 6 * HOUR, OPTS)).toBe(true);
  });

  it('does not probe twice within the interval', () => {
    const now = at('2026-08-15T03:30:00Z');
    const s = state({ lastFullSync: now - 2 * HOUR, lastCheck: now - HOUR });
    expect(isSyncDue(s, now, OPTS)).toBe(false);
  });

  it('runs at the configured night hour once the interval has passed', () => {
    const s = state({
      lastFullSync: at('2026-08-14T03:05:00Z'),
      lastCheck: at('2026-08-14T03:05:00Z'),
    });
    expect(isSyncDue(s, at('2026-08-15T03:05:00Z'), OPTS)).toBe(true);
    // ...but not at any other hour of that day.
    expect(isSyncDue(s, at('2026-08-15T11:05:00Z'), OPTS)).toBe(false);
  });

  it('forces a rebuild once the data is older than the staleness net', () => {
    // Covers a hotfix shipped under an unchanged version string, and nights the
    // bot happened to be down for.
    const now = at('2026-08-15T11:00:00Z');
    const s = state({ lastFullSync: now - 80 * HOUR, lastCheck: now - 21 * HOUR });
    expect(isSyncDue(s, now, OPTS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Full sync against a faked feed: no network, real SQLite.

const feed = vi.hoisted(() => ({
  fetchPatchList: vi.fn(),
  fetchHeroList: vi.fn(),
  fetchHero: vi.fn(),
  fetchItemList: vi.fn(),
  fetchItem: vi.fn(),
  fetchPatchNotes: vi.fn(),
  fetchConstants: vi.fn(),
}));

vi.mock('../src/dota/feed.js', () => feed);

const HERO = {
  id: 1,
  name: 'npc_dota_hero_antimage',
  name_loc: 'Anti-Mage',
  primary_attr: 1,
  str_base: 21,
  abilities: [
    {
      id: 5003,
      name: 'antimage_mana_break',
      name_loc: 'Mana Break',
      desc_loc: 'Сжигает %mana_per_hit% маны.',
      special_values: [{ name: 'mana_per_hit', values_float: [25, 30, 35, 40] }],
    },
  ],
  talents: [],
};

const ITEM = {
  id: 1,
  name: 'item_blink',
  name_loc: 'Blink Dagger',
  item_cost: 2250,
  desc_loc: 'Перемещает на %blink_range%.',
  special_values: [{ name: 'blink_range', values_float: [1200] }],
};

function primeFeed(): void {
  feed.fetchPatchList.mockResolvedValue([
    { patch_number: '7.41d', patch_name: '7.41d', patch_timestamp: 1 },
    { patch_number: '7.41e', patch_name: '7.41e', patch_timestamp: 2 },
  ]);
  feed.fetchConstants.mockResolvedValue({ heroAbilities: {}, abilities: {} });
  feed.fetchHeroList.mockResolvedValue([{ id: 1, name: HERO.name, name_loc: 'Anti-Mage' }]);
  feed.fetchHero.mockResolvedValue(HERO);
  feed.fetchItemList.mockResolvedValue([
    { id: 1, name: 'item_blink', name_loc: 'Blink Dagger' },
    { id: 2, name: 'item_recipe_manta', name_loc: 'Manta Style Recipe' },
  ]);
  feed.fetchItem.mockResolvedValue(ITEM);
  feed.fetchPatchNotes.mockResolvedValue({
    patch_number: '7.41e',
    patch_name: '7.41e',
    patch_timestamp: 2,
    heroes: [{ hero_id: 1, hero_notes: [{ note: 'Базовая ловкость снижена' }] }],
    items: [{ ability_id: 1, ability_notes: [{ note: 'Цена увеличена до 2250' }] }],
    general_notes: [{ title: 'Карта', generic: [{ note: 'Руны появляются раньше' }] }],
  });
}

async function freshSync(enabled = true) {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  process.env.ENABLE_DOTA = String(enabled);
  process.env.DOTA_FEED_DELAY_MS = '0';
  vi.resetModules();
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
  return {
    sync: await import('../src/dota/sync.js'),
    repo: await import('../src/db/repos/dota.repo.js'),
  };
}

let closeDb: () => void;
beforeEach(async () => {
  vi.clearAllMocks();
  primeFeed();
  ({ closeDb } = await import('../src/db/client.js'));
});
afterEach(() => {
  if (closeDb) closeDb();
});

describe('runDotaSync', () => {
  it('crawls the feed into rendered, resolved cards', async () => {
    const { sync, repo } = await freshSync();
    const result = await sync.runDotaSync(true);

    expect(result.status).toBe('synced');
    expect(result.patch).toBe('7.41e');
    expect(repo.countDotaEntities()).toEqual({ hero: 1, item: 1, patch: 3 });

    const hero = repo.findDotaEntity('Anti-Mage');
    expect(hero?.card).toContain('Сжигает 25/30/35/40 маны');
    expect(repo.findDotaEntity('Blink Dagger')?.card).toContain('Перемещает на 1200');
  });

  it('takes the NEWEST patch by timestamp, not by array position', async () => {
    const { sync, repo } = await freshSync();
    await sync.runDotaSync(true);
    expect(repo.getDotaSyncState().patch).toBe('7.41e');
  });

  it('still finds the current patch if the feed lists it oldest-last', async () => {
    // The list ordering is undocumented; a reversed one must not rebuild the
    // whole base on an ancient patch, which is the very failure this exists to
    // prevent.
    const { sync, repo } = await freshSync();
    feed.fetchPatchList.mockResolvedValue([
      { patch_number: '7.41e', patch_name: '7.41e', patch_timestamp: 2 },
      { patch_number: '7.41d', patch_name: '7.41d', patch_timestamp: 1 },
    ]);
    await sync.runDotaSync(true);
    expect(repo.getDotaSyncState().patch).toBe('7.41e');
  });

  it('keys patch notes by feed id, so same-named entries cannot collide', async () => {
    // Two ids, one display name (levelled items such as Dagon). Keyed by name,
    // the second insert hit UNIQUE (kind, key) and aborted the entire swap.
    const { sync, repo } = await freshSync();
    feed.fetchItemList.mockResolvedValue([
      { id: 1, name: 'item_dagon', name_loc: 'Dagon' },
      { id: 2, name: 'item_dagon_2', name_loc: 'Dagon' },
    ]);
    feed.fetchItem.mockImplementation(async (id: number) => ({
      ...ITEM,
      id,
      name: id === 1 ? 'item_dagon' : 'item_dagon_2',
      name_loc: 'Dagon',
    }));
    feed.fetchPatchNotes.mockResolvedValue({
      patch_number: '7.41e',
      patch_name: '7.41e',
      patch_timestamp: 2,
      items: [
        { ability_id: 1, ability_notes: [{ note: 'Урон Dagon 1 снижен' }] },
        { ability_id: 2, ability_notes: [{ note: 'Урон Dagon 2 снижен' }] },
      ],
    });

    const result = await sync.runDotaSync(true);
    expect(result.status).toBe('synced');
    // Heroes and items survived, and both patch blocks were stored.
    expect(repo.countDotaEntities()).toEqual({ hero: 1, item: 2, patch: 2 });
  });

  it('skips recipes — they carry no data worth indexing', async () => {
    const { sync } = await freshSync();
    await sync.runDotaSync(true);
    expect(feed.fetchItem).toHaveBeenCalledTimes(1);
    expect(feed.fetchItem).toHaveBeenCalledWith(1);
  });

  it('stores per-hero, per-item and general patch notes', async () => {
    const { sync, repo } = await freshSync();
    await sync.runDotaSync(true);

    expect(repo.findDotaEntity('Anti-Mage', 'patch')?.card).toContain(
      'Базовая ловкость снижена',
    );
    expect(repo.findDotaEntity('Blink Dagger', 'patch')?.card).toContain(
      'Цена увеличена до 2250',
    );
    expect(repo.findDotaEntity('Патч 7.41e', 'patch')?.card).toContain(
      'Руны появляются раньше',
    );
  });

  it('skips the crawl when the patch has not moved (one cheap probe only)', async () => {
    const { sync, repo } = await freshSync();
    await sync.runDotaSync(true);
    feed.fetchHero.mockClear();

    // A scheduled (non-forced) run at the night hour, a day after the last one:
    // due for a probe, but the data is neither stale nor on an old patch.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-16T03:10:00Z'));
      const dayAgo = Date.now() - 24 * HOUR;
      repo.setDotaSyncState({ lastFullSync: dayAgo, lastCheck: dayAgo });

      const second = await sync.runDotaSync(false);
      expect(second.status).toBe('up-to-date');
      expect(feed.fetchPatchList).toHaveBeenCalled();
      expect(feed.fetchHero).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not even probe when nothing is due', async () => {
    const { sync, repo } = await freshSync();
    await sync.runDotaSync(true);
    feed.fetchPatchList.mockClear();

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-16T14:00:00Z'));
      repo.setDotaSyncState({ lastFullSync: Date.now() - HOUR, lastCheck: Date.now() - HOUR });
      expect((await sync.runDotaSync(false)).status).toBe('skipped');
      expect(feed.fetchPatchList).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('crawls again when the patch moved', async () => {
    const { sync, repo } = await freshSync();
    await sync.runDotaSync(true);

    feed.fetchPatchList.mockResolvedValue([
      { patch_number: '7.42', patch_name: '7.42', patch_timestamp: 3 },
    ]);
    feed.fetchPatchNotes.mockResolvedValue(null);
    const second = await sync.runDotaSync(true);

    expect(second.status).toBe('synced');
    expect(repo.getDotaSyncState().patch).toBe('7.42');
    expect(repo.findDotaEntity('Anti-Mage')?.patch).toBe('7.42');
  });

  it('keeps the previous base when the feed goes bad mid-crawl', async () => {
    const { sync, repo } = await freshSync();
    await sync.runDotaSync(true);

    feed.fetchPatchList.mockResolvedValue([
      { patch_number: '7.42', patch_name: '7.42', patch_timestamp: 3 },
    ]);
    feed.fetchHero.mockRejectedValue(new Error('502'));
    const second = await sync.runDotaSync(true);

    // Yesterday's patch is a far better answer than an empty base.
    expect(second.status).toBe('failed');
    expect(repo.countDotaEntities().hero).toBe(1);
    expect(repo.findDotaEntity('Anti-Mage')?.patch).toBe('7.41e');
    expect(repo.getDotaSyncState().lastError).toContain('too many feed failures');
  });

  it('does nothing when the feature is off', async () => {
    const { sync } = await freshSync(false);
    const result = await sync.runDotaSync(true);

    expect(result.status).toBe('skipped');
    expect(feed.fetchPatchList).not.toHaveBeenCalled();
  });
});
