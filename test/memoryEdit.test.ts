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

  it('ignores a replaces entry that matches nothing (still pins the note)', async () => {
    const { assist, repo } = await load();
    const out = assist.rememberNote(1, 'новый факт', ['которого нет в памяти']);
    expect(out).toBe('Запомнил.'); // nothing removed → plain confirmation
    expect(repo.getAllItems(1).map((i) => i.content)).toEqual(['новый факт']);
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
