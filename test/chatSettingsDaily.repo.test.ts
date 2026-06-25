import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

async function freshRepo() {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  vi.resetModules();
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
  return import('../src/db/repos/chatSettings.repo.js');
}

let closeDb: () => void;
afterEach(async () => {
  if (closeDb) closeDb();
});
beforeEach(async () => {
  ({ closeDb } = await import('../src/db/client.js'));
});

describe('chat_settings daily spending', () => {
  it('defaults to disabled / unset for a new chat', async () => {
    const repo = await freshRepo();
    expect(repo.getDailySpending(1)).toBeNull();
    expect(repo.listDailySpendingEnabled()).toEqual([]);
  });

  it('enables with custom time and seeds the last-posted date', async () => {
    const repo = await freshRepo();
    repo.setDailySpendingEnabled(42, true, { hour: 8, minute: 30, lastDate: '2026-06-24' });
    expect(repo.getDailySpending(42)).toEqual({
      chatId: 42,
      enabled: true,
      hour: 8,
      minute: 30,
      lastDate: '2026-06-24',
    });
    expect(repo.listDailySpendingEnabled().map((s) => s.chatId)).toEqual([42]);
  });

  it('disabling removes the chat from the enabled list', async () => {
    const repo = await freshRepo();
    repo.setDailySpendingEnabled(42, true, { hour: 9, minute: 0 });
    repo.setDailySpendingEnabled(42, false);
    const s = repo.getDailySpending(42);
    expect(s?.enabled).toBe(false);
    expect(repo.listDailySpendingEnabled()).toEqual([]);
  });

  it('updates only the last-posted date', async () => {
    const repo = await freshRepo();
    repo.setDailySpendingEnabled(42, true, { hour: 9, minute: 0, lastDate: '2026-06-23' });
    repo.setDailySpendingLastDate(42, '2026-06-24');
    const s = repo.getDailySpending(42);
    expect(s?.lastDate).toBe('2026-06-24');
    expect(s?.enabled).toBe(true);
    expect(s?.hour).toBe(9);
  });

  it('coexists with the timezone setting on the same row', async () => {
    const repo = await freshRepo();
    repo.setTimezone(42, 'Europe/Berlin');
    repo.setDailySpendingEnabled(42, true, { hour: 9, minute: 0 });
    expect(repo.getTimezone(42)).toBe('Europe/Berlin');
    expect(repo.getDailySpending(42)?.enabled).toBe(true);
  });
});
