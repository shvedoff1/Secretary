import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { findDuplicate, type ScheduledTask } from '../src/db/repos/scheduledTask.repo.js';

function task(over: Partial<ScheduledTask>): ScheduledTask {
  return {
    id: 1,
    chatId: 100,
    tgUserId: 1,
    title: 'Кофе',
    prompt: 'Напомни выпить кофе',
    cron: '0 9 * * *',
    timezone: 'Europe/Lisbon',
    once: false,
    humor: false,
    enabled: true,
    nextRunAt: 0,
    lastRunAt: null,
    createdAt: 0,
    ...over,
  };
}

describe('findDuplicate', () => {
  it('matches same schedule + title (case/space-insensitive)', () => {
    const existing = [task({ id: 7, title: 'Кофе' })];
    const dup = findDuplicate(existing, { cron: '0 9 * * *', title: '  кофе ' });
    expect(dup?.id).toBe(7);
  });

  it('does not match a different time', () => {
    const existing = [task({ id: 7, cron: '0 9 * * *' })];
    expect(
      findDuplicate(existing, { cron: '0 10 * * *', title: 'Кофе' }),
    ).toBeUndefined();
  });

  it('does not match a different title', () => {
    const existing = [task({ id: 7, title: 'Кофе' })];
    expect(
      findDuplicate(existing, { cron: '0 9 * * *', title: 'Вода' }),
    ).toBeUndefined();
  });

  it('ignores disabled tasks', () => {
    const existing = [task({ id: 7, enabled: false })];
    expect(
      findDuplicate(existing, { cron: '0 9 * * *', title: 'Кофе' }),
    ).toBeUndefined();
  });
});

describe('createTask + read-back (humor flag)', () => {
  async function freshRepo() {
    process.env.BOT_TOKEN = 'x';
    process.env.ANTHROPIC_API_KEY = 'x';
    process.env.ADMIN_TELEGRAM_ID = '1';
    process.env.DATABASE_PATH = ':memory:';
    vi.resetModules();
    const { migrate } = await import('../src/db/migrate.js');
    migrate();
    const repo = await import('../src/db/repos/scheduledTask.repo.js');
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
      title: 'Кофе',
      prompt: 'Напомни выпить кофе',
      cron: '0 9 * * *',
      timezone: 'Europe/Lisbon',
      once: false,
      humor: false,
      nextRunAt: 1,
      ...over,
    };
  }

  it('persists and reads back humor=true', async () => {
    const { repo, closeDb } = await freshRepo();
    close = closeDb;
    const id = repo.createTask(baseArgs({ humor: true }));
    const [t] = repo.listTasks(100);
    expect(t!.id).toBe(id);
    expect(t!.humor).toBe(true);
    expect(repo.dueTasks(2)[0]!.humor).toBe(true);
  });

  it('defaults humor=false through', async () => {
    const { repo, closeDb } = await freshRepo();
    close = closeDb;
    repo.createTask(baseArgs({ humor: false }));
    expect(repo.listTasks(100)[0]!.humor).toBe(false);
  });

  it('setTaskHumor toggles an existing task in the same chat', async () => {
    const { repo, closeDb } = await freshRepo();
    close = closeDb;
    const id = repo.createTask(baseArgs({ humor: false }));

    expect(repo.setTaskHumor(id, 100, true)).toBe(true);
    expect(repo.listTasks(100)[0]!.humor).toBe(true);

    expect(repo.setTaskHumor(id, 100, false)).toBe(true);
    expect(repo.listTasks(100)[0]!.humor).toBe(false);
  });

  it('setTaskHumor refuses a task from another chat', async () => {
    const { repo, closeDb } = await freshRepo();
    close = closeDb;
    const id = repo.createTask(baseArgs({ humor: false }));
    expect(repo.setTaskHumor(id, 999, true)).toBe(false);
    expect(repo.listTasks(100)[0]!.humor).toBe(false);
  });

  it('setTaskHumor returns false for an unknown task', async () => {
    const { repo, closeDb } = await freshRepo();
    close = closeDb;
    expect(repo.setTaskHumor(424242, 100, true)).toBe(false);
  });
});
