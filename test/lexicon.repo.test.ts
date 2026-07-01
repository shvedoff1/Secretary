import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Each test gets a fresh in-memory DB with migrations applied. The repo is imported
// dynamically after env + module reset so it binds to the freshly-opened DB.
async function freshRepo() {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  vi.resetModules();
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
  return import('../src/db/repos/lexicon.repo.js');
}

let closeDb: () => void;
afterEach(async () => {
  if (closeDb) closeDb();
});

beforeEach(async () => {
  ({ closeDb } = await import('../src/db/client.js'));
});

describe('lexicon repo: samples', () => {
  it('buffers samples and reports count + oldest', async () => {
    const repo = await freshRepo();
    repo.recordSample(1, 'тип здарова');
    repo.recordSample(1, 'братик');
    repo.recordSample(2, 'other chat');

    const stats = repo.sampleStats(1);
    expect(stats.count).toBe(2);
    expect(stats.oldestAt).toBeTypeOf('number');
    expect(repo.sampleStats(99).count).toBe(0);
    expect(repo.sampleStats(99).oldestAt).toBeNull();
  });

  it('claimSamples returns and clears a chat buffer (idempotent after)', async () => {
    const repo = await freshRepo();
    repo.recordSample(1, 'one');
    repo.recordSample(1, 'two');

    expect(repo.claimSamples(1)).toEqual(['one', 'two']);
    expect(repo.sampleStats(1).count).toBe(0);
    // A second claim finds nothing — protects against double processing.
    expect(repo.claimSamples(1)).toEqual([]);
  });

  it('claim only touches the given chat', async () => {
    const repo = await freshRepo();
    repo.recordSample(1, 'a');
    repo.recordSample(2, 'b');
    repo.claimSamples(1);
    expect(repo.sampleStats(2).count).toBe(1);
  });

  it('staleSampleChats lists chats with samples at/older than the cutoff', async () => {
    const repo = await freshRepo();
    repo.recordSample(1, 'recent');
    const now = Date.now();
    // Nothing is older than a cutoff in the past...
    expect(repo.staleSampleChats(now - 60_000)).toEqual([]);
    // ...everything is older than a cutoff in the future.
    expect(repo.staleSampleChats(now + 60_000)).toEqual([1]);
  });
});

describe('lexicon repo: terms', () => {
  it('records terms and bumps frequency on re-seeing (case-insensitive)', async () => {
    const repo = await freshRepo();
    repo.recordTerms(1, [
      { term: 'тип', gloss: 'типа' },
      { term: 'братик', gloss: '' },
    ]);
    repo.recordTerms(1, [{ term: 'ТИП', gloss: 'типа' }]);

    const entries = repo.getLexicon(1);
    const tip = entries.find((e) => e.term === 'тип');
    expect(tip?.frequency).toBe(2);
    expect(tip?.gloss).toBe('типа');
    // Most-used first.
    expect(entries[0]?.term).toBe('тип');
  });

  it('keeps an existing gloss when a later batch has none, updates when it has one', async () => {
    const repo = await freshRepo();
    repo.recordTerms(1, [{ term: 'кек', gloss: 'смешно' }]);
    repo.recordTerms(1, [{ term: 'кек', gloss: '' }]);
    expect(repo.getLexicon(1)[0]?.gloss).toBe('смешно');
    repo.recordTerms(1, [{ term: 'кек', gloss: 'очень смешно' }]);
    expect(repo.getLexicon(1)[0]?.gloss).toBe('очень смешно');
  });

  it('skips blank terms and respects the limit', async () => {
    const repo = await freshRepo();
    repo.recordTerms(1, [
      { term: '  ', gloss: 'x' },
      { term: 'a', gloss: '' },
      { term: 'b', gloss: '' },
    ]);
    expect(repo.getLexicon(1)).toHaveLength(2);
    expect(repo.getLexicon(1, 1)).toHaveLength(1);
  });

  it('setGloss changes the meaning of an existing term (case-insensitive), returns the stored form', async () => {
    const repo = await freshRepo();
    repo.recordTerms(1, [{ term: 'пихалыч', gloss: 'непонятно' }]);

    const res = repo.setGloss(1, 'ПихалыЧ', 'рот, пасть');
    expect(res).toEqual({ updated: true, term: 'пихалыч' });
    expect(repo.getLexicon(1)[0]?.gloss).toBe('рот, пасть');
  });

  it('setGloss finds a term by unique containment (типа ↔ тип)', async () => {
    const repo = await freshRepo();
    repo.recordTerms(1, [{ term: 'тип', gloss: 'типа' }]);
    // User typed the fuller form; still resolves to the stored «тип».
    const res = repo.setGloss(1, 'типа', 'вроде');
    expect(res).toEqual({ updated: true, term: 'тип' });
    expect(repo.getLexicon(1)[0]?.gloss).toBe('вроде');
  });

  it('setGloss does not update when there is no match or the match is ambiguous', async () => {
    const repo = await freshRepo();
    repo.recordTerms(1, [
      { term: 'кек', gloss: 'смешно' },
      { term: 'кекич', gloss: 'смешно2' },
    ]);
    // No such word at all.
    expect(repo.setGloss(1, 'бугага', 'x').updated).toBe(false);
    // «кеки» is contained in «кекич» and contains «кек» → matches BOTH stored terms,
    // so it's ambiguous and nothing is changed (no exact «кеки» to disambiguate).
    const res = repo.setGloss(1, 'кеки', 'y');
    expect(res.updated).toBe(false);
    expect(repo.getLexicon(1).every((e) => e.gloss.startsWith('смешно'))).toBe(true);
  });

  it('setGloss never creates a new term, and rejects a blank term', async () => {
    const repo = await freshRepo();
    expect(repo.setGloss(1, 'newword', 'meaning').updated).toBe(false);
    expect(repo.getLexicon(1)).toEqual([]);
    expect(repo.setGloss(1, '   ', 'meaning').updated).toBe(false);
  });

  it('clearLexicon wipes terms and buffered samples for the chat only', async () => {
    const repo = await freshRepo();
    repo.recordTerms(1, [{ term: 'a', gloss: '' }]);
    repo.recordSample(1, 'buffered');
    repo.recordTerms(2, [{ term: 'keep', gloss: '' }]);

    repo.clearLexicon(1);
    expect(repo.getLexicon(1)).toEqual([]);
    expect(repo.sampleStats(1).count).toBe(0);
    expect(repo.getLexicon(2)).toHaveLength(1);
  });
});
