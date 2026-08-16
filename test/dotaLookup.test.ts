import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DotaEntityInput } from '../src/db/repos/dota.repo.js';

async function freshLookup(enabled = true) {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  process.env.ENABLE_DOTA = String(enabled);
  vi.resetModules();
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
  return {
    lookup: (await import('../src/dota/lookup.js')).makeDotaLookupHandler(),
    repo: await import('../src/db/repos/dota.repo.js'),
  };
}

const HERO: DotaEntityInput = {
  kind: 'hero',
  key: 'npc_dota_hero_antimage',
  feedId: 1,
  name: 'Anti-Mage',
  card: 'Герой: Anti-Mage — Mana Break сжигает 25/30/35/40 маны',
  summary: 'Anti-Mage — керри',
  search: 'Anti-Mage Mana Break Blink сжигает ману керри',
};
const ITEM: DotaEntityInput = {
  kind: 'item',
  key: 'item_blink',
  feedId: 1,
  name: 'Blink Dagger',
  card: 'Предмет: Blink Dagger — цена 2250, перезарядка 15 с',
  summary: 'Blink Dagger — 2250',
  search: 'Blink Dagger телепорт 1200 перезарядка',
};
const BKB: DotaEntityInput = {
  kind: 'item',
  key: 'item_black_king_bar',
  feedId: 2,
  name: 'Black King Bar',
  card: 'Предмет: Black King Bar — цена 4050, невосприимчивость к магии',
  summary: 'Black King Bar — 4050',
  search: 'Black King Bar невосприимчивость к магии',
};
const PATCH: DotaEntityInput = {
  kind: 'patch',
  key: 'patch:hero:Anti-Mage',
  name: 'Anti-Mage',
  card: 'Изменения в патче 7.41e — Anti-Mage: Mana Break ослаблен',
  summary: 'Anti-Mage — изменения',
  search: 'Anti-Mage патч Mana Break',
};

let closeDb: () => void;
beforeEach(async () => {
  ({ closeDb } = await import('../src/db/client.js'));
});
afterEach(() => {
  if (closeDb) closeDb();
});

describe('dota_lookup handler', () => {
  it('returns the full card and labels the patch it came from', async () => {
    const { lookup, repo } = await freshLookup();
    repo.replaceDotaEntities([HERO, ITEM], '7.41e');
    repo.setDotaSyncState({ patch: '7.41e' });

    const out = lookup({ kind: 'item', names: ['Blink Dagger'], query: null });
    expect(out).toContain('патч 7.41e');
    expect(out).toContain('цена 2250');
  });

  it('attaches the entity\'s patch notes so no second call is needed', async () => {
    const { lookup, repo } = await freshLookup();
    repo.replaceDotaEntities([HERO, PATCH], '7.41e');

    const out = lookup({ kind: 'hero', names: ['Anti-Mage'], query: null });
    expect(out).toContain('Mana Break сжигает');
    expect(out).toContain('Mana Break ослаблен');
  });

  it('looks up several entities in one call', async () => {
    const { lookup, repo } = await freshLookup();
    repo.replaceDotaEntities([ITEM, BKB], '7.41e');

    const out = lookup({ kind: 'item', names: ['Blink Dagger', 'Black King Bar'], query: null });
    expect(out).toContain('Blink Dagger');
    expect(out).toContain('Black King Bar');
  });

  it('suggests near matches instead of inventing an answer', async () => {
    const { lookup, repo } = await freshLookup();
    repo.replaceDotaEntities([ITEM, BKB], '7.41e');

    const out = lookup({ kind: 'item', names: ['Black King Bard'], query: null });
    expect(out).toContain('точного совпадения нет');
    expect(out).toContain('Black King Bar');
  });

  it('says plainly when nothing resembles the name', async () => {
    const { lookup, repo } = await freshLookup();
    repo.replaceDotaEntities([ITEM], '7.41e');

    const out = lookup({ kind: 'any', names: ['Ковер-самолёт'], query: null });
    expect(out).toContain('не нашёл в базе');
  });

  it('answers a freetext query from the search index', async () => {
    const { lookup, repo } = await freshLookup();
    repo.replaceDotaEntities([HERO, ITEM, BKB], '7.41e');

    const out = lookup({ kind: 'any', names: null, query: 'невосприимчивость к магии' });
    expect(out).toContain('Black King Bar');
    expect(out).not.toContain('Anti-Mage');
  });

  it('caps how many entities one call returns', async () => {
    process.env.DOTA_MAX_CARDS = '1';
    try {
      const { lookup, repo } = await freshLookup();
      repo.replaceDotaEntities([ITEM, BKB], '7.41e');

      const out = lookup({
        kind: 'item',
        names: ['Blink Dagger', 'Black King Bar'],
        query: null,
      });
      expect(out).toContain('Blink Dagger');
      // The capped entity's CARD is not returned — only a note that it was left
      // out (see the "says which names did not fit" case below).
      expect(out).not.toContain('Black King Bar — 4050');
      expect(out).not.toContain('невосприимчивость к магии');
    } finally {
      delete process.env.DOTA_MAX_CARDS;
    }
  });

  it('says which names did not fit instead of silently dropping them', async () => {
    // The schema allows 8 names, DOTA_MAX_CARDS caps the answer — the model has
    // to know the difference, or it reports on four heroes as though it covered
    // all eight.
    process.env.DOTA_MAX_CARDS = '1';
    try {
      const { lookup, repo } = await freshLookup();
      repo.replaceDotaEntities([ITEM, BKB], '7.41e');

      const out = lookup({
        kind: 'item',
        names: ['Blink Dagger', 'Black King Bar'],
        query: null,
      });
      expect(out).toContain('Не поместились');
      expect(out).toContain('Black King Bar');
    } finally {
      delete process.env.DOTA_MAX_CARDS;
    }
  });

  it('pays for attached patch notes out of the same budget', async () => {
    // Patch cards used to bypass the char budget entirely, so asking about a few
    // heroes right after a patch quietly doubled the tool result.
    const { lookup, repo } = await freshLookup();
    const long = 'ж'.repeat(6000);
    repo.replaceDotaEntities(
      [
        { ...HERO, card: `Герой: Anti-Mage — ${long}` },
        { ...PATCH, card: `Изменения — ${long}`, summary: 'Anti-Mage — краткие изменения' },
      ],
      '7.41e',
    );

    const out = lookup({ kind: 'hero', names: ['Anti-Mage'], query: null });
    // The hero card spent the budget, so the patch card degrades to its digest
    // rather than being appended in full.
    expect(out).toContain('Anti-Mage — краткие изменения');
    expect(out).not.toContain(`Изменения — ${long}`);
  });

  it('does not suggest the same name twice in a near miss', async () => {
    // A hero and its patch card share a display name — "Похожее: Axe, Axe".
    const { lookup, repo } = await freshLookup();
    repo.replaceDotaEntities([HERO, PATCH], '7.41e');

    const out = lookup({ kind: 'any', names: ['Anti-Mageee'], query: null });
    expect(out).toContain('точного совпадения нет');
    expect(out.match(/Anti-Mage/g)?.length).toBe(2); // the asked name + one suggestion
  });

  it('tells the model to flag uncertainty when the base is empty', async () => {
    const { lookup } = await freshLookup();
    const out = lookup({ kind: 'any', names: ['Blink Dagger'], query: null });
    expect(out).toContain('ещё не загружена');
    expect(out).toContain('устаревш');
  });

  it('says the feature is off rather than pretending to have data', async () => {
    const { lookup } = await freshLookup(false);
    const out = lookup({ kind: 'any', names: ['Blink Dagger'], query: null });
    expect(out).toContain('выключена');
  });
});
