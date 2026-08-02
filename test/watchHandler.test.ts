import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { WatchPageInput } from '../src/llm/schema.js';

// The watch_page tool handler: the «следи за страницей и напиши, когда появятся
// сеансы» flow. Its confirmation feeds straight back into the model's reply, and
// its validation is what keeps the poll loop sane (bounded pace, capped count).

async function load() {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  vi.resetModules();
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
  const assist = await import('../src/bot/flows/assist.js');
  const repo = await import('../src/db/repos/pageWatch.repo.js');
  return { assist, repo };
}

let closeDb: () => void;
afterEach(() => {
  if (closeDb) closeDb();
});
beforeEach(async () => {
  ({ closeDb } = await import('../src/db/client.js'));
});

function input(over: Partial<WatchPageInput> = {}): WatchPageInput {
  return {
    title: 'Сеансы Титана',
    url: 'https://kinomax.ru/titan/2026-08-06',
    condition: 'появились сеансы фильма «Титан»',
    keywords: ['Титан', 'titan'],
    intervalMinutes: null,
    expiresInDays: null,
    ...over,
  };
}

describe('makeWatchPageHandler', () => {
  it('arms a watch due immediately, with defaults, and confirms with /watch', async () => {
    const { assist, repo } = await load();
    const out = assist.makeWatchPageHandler(1, 42)(input());

    const [w] = repo.listWatches(1);
    expect(w).toBeDefined();
    expect(w!.url).toBe('https://kinomax.ru/titan/2026-08-06');
    expect(w!.intervalMinutes).toBe(15); // WATCH_INTERVAL_MINUTES default
    expect(w!.nextCheckAt).toBeLessThanOrEqual(Date.now()); // first poll on next tick
    expect(w!.keywords).toEqual(['титан', 'titan']); // lowercased + deduped
    expect(out).toContain(`#${w!.id}`);
    expect(out).toContain('/watch');
  });

  it('clamps a too-eager interval to 5 minutes and honours a sane explicit one', async () => {
    const { assist, repo } = await load();
    const handler = assist.makeWatchPageHandler(1, 42);
    handler(input({ intervalMinutes: 1 }));
    handler(input({ intervalMinutes: 30, condition: 'другое событие' }));
    const [a, b] = repo.listWatches(1);
    expect(a!.intervalMinutes).toBe(5);
    expect(b!.intervalMinutes).toBe(30);
  });

  it('refuses a non-http url without creating anything', async () => {
    const { assist, repo } = await load();
    const out = assist.makeWatchPageHandler(1, 42)(input({ url: 'ftp://kinomax.ru/x' }));
    expect(repo.listWatches(1)).toEqual([]);
    expect(out).toContain('http');
  });

  it('does not re-create the same watch (url + condition), pointing at the existing id', async () => {
    const { assist, repo } = await load();
    const handler = assist.makeWatchPageHandler(1, 42);
    handler(input());
    const out = handler(input({ url: 'https://kinomax.ru/titan/2026-08-06/' }));
    const watches = repo.listWatches(1);
    expect(watches.length).toBe(1);
    expect(out).toContain(`#${watches[0]!.id}`);
    expect(out).toContain('Уже слежу');
  });

  it('caps active watches per chat (WATCH_MAX_PER_CHAT default 10)', async () => {
    const { assist, repo } = await load();
    const handler = assist.makeWatchPageHandler(1, 42);
    for (let i = 0; i < 10; i++) {
      handler(input({ condition: `событие ${i}` }));
    }
    const out = handler(input({ condition: 'одиннадцатое' }));
    expect(repo.listWatches(1).length).toBe(10);
    expect(out).toContain('потолок');
  });

  it('refuses when the keywords boil down to nothing', async () => {
    const { assist, repo } = await load();
    const out = assist.makeWatchPageHandler(1, 42)(input({ keywords: ['  ', ''] }));
    expect(repo.listWatches(1)).toEqual([]);
    expect(out).toContain('слова');
  });
});
