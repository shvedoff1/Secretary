import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

// Handler-level behaviour of the memory-write path: remember (with supersede) and
// edit_memory, run for real against an in-memory DB via the repo.
async function load() {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  vi.resetModules();
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
  const assist = await import('../src/bot/flows/assist.js');
  const repo = await import('../src/db/repos/memoryItem.repo.js');
  return { assist, repo };
}

let closeDb: () => void;
beforeEach(async () => {
  ({ closeDb } = await import('../src/db/client.js'));
});
afterEach(() => {
  if (closeDb) closeDb();
});

describe('rememberNote', () => {
  it('pins a plain note verbatim', async () => {
    const { assist, repo } = await load();
    expect(assist.rememberNote(1, 'любит серф на рассвете')).toBe('Запомнил.');
    expect(repo.getAllItems(1).map((i) => i.content)).toEqual(['любит серф на рассвете']);
  });

  it('refuses an expense-like note (money belongs in Splid)', async () => {
    const { assist, repo } = await load();
    const out = assist.rememberNote(1, 'Расход на кофе 260 тыс, платил Антон, делится');
    expect(out).toMatch(/Splid/);
    expect(repo.getAllItems(1)).toHaveLength(0);
  });

  it('supersedes contradicted facts named in replaces', async () => {
    const { assist, repo } = await load();
    repo.insertPinned(1, 'Итого 5 человек: Шведский, Антоха, Иванес, Миша, Михалыч');
    const out = assist.rememberNote(1, 'Итого 4 человека', [
      'Итого 5 человек: Шведский, Антоха, Иванес, Миша, Михалыч',
    ]);
    expect(out).toMatch(/Обновил/);
    const contents = repo.getAllItems(1).map((i) => i.content);
    expect(contents).toEqual(['Итого 4 человека']); // old removed, new pinned
  });

  it('surfaces a failed override instead of a misleading success', async () => {
    const { assist, repo } = await load();
    repo.insertPinned(1, 'нас 5 человек');
    // The model paraphrases the old fact so it does not match — the override fails.
    const out = assist.rememberNote(1, 'нас 4 человека', ['нас пятеро было раньше']);
    expect(out).toMatch(/не нашёл/i); // does NOT claim a clean update
    const contents = repo.getAllItems(1).map((i) => i.content).sort();
    // Both survive (nothing matched), but the user was told, not misled.
    expect(contents).toEqual(['нас 4 человека', 'нас 5 человек']);
  });

  it('resolves all replaces against the original state, not mutated mid-loop', async () => {
    const { assist, repo } = await load();
    repo.insertPinned(1, 'серфинг утром');
    repo.insertPinned(1, 'серфинг вечером');
    // "серфинг" is ambiguous (two containment matches) and must stay ambiguous even
    // after "серфинг утром" is removed — so the evening fact is NOT collateral-nuked.
    const out = assist.rememberNote(1, 'серфинг днём', ['серфинг утром', 'серфинг']);
    const contents = repo.getAllItems(1).map((i) => i.content).sort();
    expect(contents).toContain('серфинг вечером'); // survived
    expect(contents).toContain('серфинг днём'); // new note pinned
    expect(contents).not.toContain('серфинг утром'); // the one real match removed
    expect(out).toMatch(/не нашёл/i); // "серфинг" was unresolved → surfaced
  });
});

describe('makeEditMemoryHandler', () => {
  it('overwrites a matched fact in place', async () => {
    const { assist, repo } = await load();
    const id = repo.insertPinned(1, 'Итого 5 человек');
    const edit = assist.makeEditMemoryHandler(1);
    const out = edit({ find: 'итого 5 человек', replace: 'Итого 4 человека' });
    expect(out).toMatch(/Поправил/);
    const it = repo.getAllItems(1)[0]!;
    expect(it.id).toBe(id);
    expect(it.content).toBe('Итого 4 человека');
  });

  it('says so when the fact cannot be found', async () => {
    const { assist } = await load();
    const edit = assist.makeEditMemoryHandler(1);
    expect(edit({ find: 'ничего такого', replace: 'x' })).toMatch(/Не нашёл/);
  });
});
