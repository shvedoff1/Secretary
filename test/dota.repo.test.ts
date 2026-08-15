import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vi } from 'vitest';

async function freshRepo() {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  vi.resetModules();
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
  return import('../src/db/repos/dota.repo.js');
}

let closeDb: () => void;
beforeEach(async () => {
  ({ closeDb } = await import('../src/db/client.js'));
});
afterEach(() => {
  if (closeDb) closeDb();
});

const HERO = {
  kind: 'hero' as const,
  key: 'npc_dota_hero_antimage',
  feedId: 1,
  name: 'Anti-Mage',
  card: 'Герой: Anti-Mage — блинк каждые 15 секунд',
  summary: 'Anti-Mage — carry',
  search: 'Anti-Mage antimage Mana Break Blink сжигает ману',
};
const ITEM = {
  kind: 'item' as const,
  key: 'item_blink',
  feedId: 1,
  name: 'Blink Dagger',
  card: 'Предмет: Blink Dagger — цена 2250',
  summary: 'Blink Dagger — 2250',
  search: 'Blink Dagger телепортирует героя на 1200',
};
const PATCH = {
  kind: 'patch' as const,
  key: 'patch:hero:Anti-Mage',
  name: 'Anti-Mage',
  card: 'Изменения в патче 7.41e — Anti-Mage: база ловкости снижена',
  summary: 'Anti-Mage patch',
  search: 'Anti-Mage патч 7.41e ловкость',
};

describe('normalizeDotaName', () => {
  it('folds case, punctuation and the feed key prefixes together', async () => {
    const repo = await freshRepo();
    const forms = ['Anti-Mage', 'anti mage', 'ANTIMAGE', 'npc_dota_hero_antimage'];
    for (const f of forms) expect(repo.normalizeDotaName(f)).toBe('antimage');
    expect(repo.normalizeDotaName('item_blink')).toBe('blink');
  });
});

describe('dota entity store', () => {
  it('finds an entity by display name, key or a sloppy spelling', async () => {
    const repo = await freshRepo();
    repo.replaceDotaEntities([HERO, ITEM], '7.41e');

    for (const q of ['Anti-Mage', 'antimage', 'npc_dota_hero_antimage', 'anti mage']) {
      expect(repo.findDotaEntity(q)?.name, q).toBe('Anti-Mage');
    }
    expect(repo.findDotaEntity('blink')?.name).toBe('Blink Dagger');
    expect(repo.findDotaEntity('Blink Dagger')?.name).toBe('Blink Dagger');
    expect(repo.findDotaEntity('Юзербот')).toBeNull();
  });

  it('keeps patch notes out of a plain name lookup but reachable by kind', async () => {
    const repo = await freshRepo();
    repo.replaceDotaEntities([HERO, PATCH], '7.41e');
    // Same name on two rows: the hero card must win for a normal question.
    expect(repo.findDotaEntity('Anti-Mage')?.kind).toBe('hero');
    expect(repo.findDotaEntity('Anti-Mage', 'patch')?.kind).toBe('patch');
  });

  it('respects an explicit kind filter', async () => {
    const repo = await freshRepo();
    repo.replaceDotaEntities([HERO, ITEM], '7.41e');
    expect(repo.findDotaEntity('Anti-Mage', 'item')).toBeNull();
    expect(repo.findDotaEntity('Blink Dagger', 'item')?.name).toBe('Blink Dagger');
  });

  it('searches the freetext index, in Russian too', async () => {
    const repo = await freshRepo();
    repo.replaceDotaEntities([HERO, ITEM], '7.41e');
    expect(repo.searchDotaEntities('телепортирует').map((e) => e.name)).toEqual([
      'Blink Dagger',
    ]);
    expect(repo.searchDotaEntities('сжигает ману').map((e) => e.name)).toEqual([
      'Anti-Mage',
    ]);
  });

  it('never lets user phrasing break the FTS query', async () => {
    const repo = await freshRepo();
    repo.replaceDotaEntities([HERO, ITEM], '7.41e');
    // Quotes, operators and lone punctuation are phrasing, not FTS syntax.
    expect(() => repo.searchDotaEntities('"blink" OR NEAR(* *)')).not.toThrow();
    expect(repo.searchDotaEntities('???')).toEqual([]);
  });

  it('replaces the whole base atomically, aliases and index included', async () => {
    const repo = await freshRepo();
    repo.replaceDotaEntities([HERO, ITEM], '7.41e');
    repo.replaceDotaEntities([ITEM], '7.42');

    expect(repo.findDotaEntity('Anti-Mage')).toBeNull();
    expect(repo.searchDotaEntities('сжигает')).toEqual([]);
    expect(repo.findDotaEntity('Blink Dagger')?.patch).toBe('7.42');
    expect(repo.countDotaEntities()).toEqual({ hero: 0, item: 1, patch: 0 });
  });

  it('round-trips sync state and merges partial updates', async () => {
    const repo = await freshRepo();
    expect(repo.getDotaSyncState()).toEqual({
      patch: null,
      lastFullSync: null,
      lastCheck: null,
      lastError: null,
    });

    repo.setDotaSyncState({ patch: '7.41e', lastFullSync: 1000, lastCheck: 1000 });
    repo.setDotaSyncState({ lastError: 'boom' });
    expect(repo.getDotaSyncState()).toEqual({
      patch: '7.41e',
      lastFullSync: 1000,
      lastCheck: 1000,
      lastError: 'boom',
    });
  });
});
