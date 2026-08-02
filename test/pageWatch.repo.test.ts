import { describe, it, expect, afterEach, vi } from 'vitest';
import { findDuplicateWatch, type PageWatch } from '../src/db/repos/pageWatch.repo.js';

function watch(over: Partial<PageWatch>): PageWatch {
  return {
    id: 1,
    chatId: 100,
    tgUserId: 1,
    title: 'Сеансы Титана',
    url: 'https://kinomax.ru/titan/2026-08-06',
    condition: 'появились сеансы фильма «Титан»',
    keywords: ['титан', 'titan'],
    intervalMinutes: 15,
    expiresAt: 10_000,
    enabled: true,
    nextCheckAt: 0,
    lastCheckedAt: null,
    lastHash: null,
    failCount: 0,
    firedAt: null,
    createdAt: 0,
    ...over,
  };
}

describe('findDuplicateWatch', () => {
  it('matches the same url + condition (case/space/trailing-slash-insensitive)', () => {
    const existing = [watch({ id: 7 })];
    const dup = findDuplicateWatch(existing, {
      url: 'https://kinomax.ru/titan/2026-08-06/',
      condition: '  Появились сеансы  фильма «Титан» ',
    });
    expect(dup?.id).toBe(7);
  });

  it('does not match a different url or a different condition', () => {
    const existing = [watch({ id: 7 })];
    expect(
      findDuplicateWatch(existing, {
        url: 'https://kinomax.ru/titan/2026-08-07',
        condition: 'появились сеансы фильма «Титан»',
      }),
    ).toBeUndefined();
    expect(
      findDuplicateWatch(existing, {
        url: 'https://kinomax.ru/titan/2026-08-06',
        condition: 'появились билеты на «Дракона»',
      }),
    ).toBeUndefined();
  });

  it('ignores disarmed watches', () => {
    const existing = [watch({ id: 7, enabled: false })];
    expect(
      findDuplicateWatch(existing, {
        url: 'https://kinomax.ru/titan/2026-08-06',
        condition: 'появились сеансы фильма «Титан»',
      }),
    ).toBeUndefined();
  });
});

describe('page_watch repo round-trip', () => {
  async function freshRepo() {
    process.env.BOT_TOKEN = 'x';
    process.env.ANTHROPIC_API_KEY = 'x';
    process.env.ADMIN_TELEGRAM_ID = '1';
    process.env.DATABASE_PATH = ':memory:';
    vi.resetModules();
    const { migrate } = await import('../src/db/migrate.js');
    migrate();
    const repo = await import('../src/db/repos/pageWatch.repo.js');
    const { closeDb } = await import('../src/db/client.js');
    return { repo, closeDb };
  }

  let close: () => void;
  afterEach(() => {
    if (close) close();
  });

  function baseArgs(over: Record<string, unknown> = {}) {
    return {
      chatId: 100,
      tgUserId: 1,
      title: 'Сеансы Титана',
      url: 'https://kinomax.ru/titan/2026-08-06',
      condition: 'появились сеансы фильма «Титан»',
      keywords: ['титан', 'titan'],
      intervalMinutes: 15,
      expiresAt: 9_999_999,
      nextCheckAt: 1,
      ...over,
    };
  }

  it('persists and reads back a watch, keywords surviving the JSON round-trip', async () => {
    const { repo, closeDb } = await freshRepo();
    close = closeDb;
    const id = repo.createWatch(baseArgs());
    const [w] = repo.listWatches(100);
    expect(w!.id).toBe(id);
    expect(w!.keywords).toEqual(['титан', 'titan']);
    expect(w!.enabled).toBe(true);
    expect(w!.lastHash).toBeNull();
    expect(w!.failCount).toBe(0);
  });

  it('dueWatches returns only watches whose next check has arrived', async () => {
    const { repo, closeDb } = await freshRepo();
    close = closeDb;
    repo.createWatch(baseArgs({ nextCheckAt: 100 }));
    repo.createWatch(baseArgs({ nextCheckAt: 900, condition: 'другое' }));
    expect(repo.dueWatches(500).length).toBe(1);
    expect(repo.dueWatches(1000).length).toBe(2);
  });

  it('setCheckResult schedules the next poll and stores hash + fail count', async () => {
    const { repo, closeDb } = await freshRepo();
    close = closeDb;
    const id = repo.createWatch(baseArgs());
    repo.setCheckResult(id, {
      nextCheckAt: 5_000,
      lastCheckedAt: 4_000,
      lastHash: 'abc',
      failCount: 2,
    });
    const [w] = repo.listWatches(100);
    expect(w!.nextCheckAt).toBe(5_000);
    expect(w!.lastCheckedAt).toBe(4_000);
    expect(w!.lastHash).toBe('abc');
    expect(w!.failCount).toBe(2);
  });

  it('disableWatch(firedAt) disarms and records when the event fired', async () => {
    const { repo, closeDb } = await freshRepo();
    close = closeDb;
    const id = repo.createWatch(baseArgs());
    repo.disableWatch(id, 7_777);
    expect(repo.listWatches(100)).toEqual([]);
    expect(repo.dueWatches(999_999)).toEqual([]);
  });

  it('deleteWatch is scoped to the chat', async () => {
    const { repo, closeDb } = await freshRepo();
    close = closeDb;
    const id = repo.createWatch(baseArgs());
    expect(repo.deleteWatch(id, 999)).toBe(false);
    expect(repo.deleteWatch(id, 100)).toBe(true);
    expect(repo.listWatches(100)).toEqual([]);
  });

  it('forceCheck pulls the next poll to now, only for an active watch in the chat', async () => {
    const { repo, closeDb } = await freshRepo();
    close = closeDb;
    const id = repo.createWatch(baseArgs({ nextCheckAt: 9_999 }));
    expect(repo.forceCheck(id, 999)).toBe(false);
    expect(repo.forceCheck(id, 100)).toBe(true);
    expect(repo.dueWatches(1).length).toBe(1);
    repo.disableWatch(id);
    expect(repo.forceCheck(id, 100)).toBe(false);
  });

  it('tolerates corrupted keywords JSON (reads back as an empty list)', async () => {
    const { repo, closeDb } = await freshRepo();
    close = closeDb;
    const id = repo.createWatch(baseArgs());
    const { getDb } = await import('../src/db/client.js');
    getDb().prepare('UPDATE page_watch SET keywords = ? WHERE id = ?').run('not json', id);
    expect(repo.listWatches(100)[0]!.keywords).toEqual([]);
  });
});
