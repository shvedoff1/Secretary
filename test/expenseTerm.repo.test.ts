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
  return import('../src/db/repos/expenseTerm.repo.js');
}

let closeDb: () => void;
afterEach(async () => {
  if (closeDb) closeDb();
});
beforeEach(async () => {
  ({ closeDb } = await import('../src/db/client.js'));
});

describe('expenseTerm repo', () => {
  it('adds, normalizes and lists terms; getExpenseTerms returns the strings', async () => {
    const repo = await freshRepo();
    const added = repo.addExpenseTerms(1, ['  Дошик ', 'на Бензин'], 42);
    expect(added).toEqual(['дошик', 'на бензин']);

    expect(repo.getExpenseTerms(1).sort()).toEqual(['дошик', 'на бензин']);
    expect(repo.listExpenseTerms(1).map((e) => e.term).sort()).toEqual(['дошик', 'на бензин']);
  });

  it('de-duplicates within a call and against existing rows', async () => {
    const repo = await freshRepo();
    expect(repo.addExpenseTerms(1, ['дошик', 'ДОШИК', '  дошик  '], null)).toEqual(['дошик']);
    // Re-adding an existing term stores nothing new.
    expect(repo.addExpenseTerms(1, ['дошик'], null)).toEqual([]);
    expect(repo.getExpenseTerms(1)).toEqual(['дошик']);
  });

  it('skips blank terms', async () => {
    const repo = await freshRepo();
    expect(repo.addExpenseTerms(1, ['   ', '', 'кофе'], null)).toEqual(['кофе']);
  });

  it('keeps terms per-chat and clears only the given chat', async () => {
    const repo = await freshRepo();
    repo.addExpenseTerms(1, ['дошик'], null);
    repo.addExpenseTerms(2, ['кофе'], null);
    repo.clearExpenseTerms(1);
    expect(repo.getExpenseTerms(1)).toEqual([]);
    expect(repo.getExpenseTerms(2)).toEqual(['кофе']);
  });
});
