import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

async function freshRepo() {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  vi.resetModules();
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
  return import('../src/db/repos/memory.repo.js');
}

let closeDb: () => void;
afterEach(async () => {
  if (closeDb) closeDb();
});
beforeEach(async () => {
  ({ closeDb } = await import('../src/db/client.js'));
});

describe('memory repo', () => {
  it('lists memory entries with the bullet prefix stripped', async () => {
    const repo = await freshRepo();
    repo.appendMemory(1, 'любит кофе');
    repo.appendMemory(1, 'часовой пояс Bali');
    expect(repo.listMemoryLines(1)).toEqual(['любит кофе', 'часовой пояс Bali']);
  });

  it('removes a single memory line by 1-based index', async () => {
    const repo = await freshRepo();
    repo.appendMemory(1, 'любит кофе');
    repo.appendMemory(1, 'часовой пояс Bali');
    repo.appendMemory(1, 'оффтоп про драконов');

    expect(repo.removeMemoryLine(1, 3)).toBe('оффтоп про драконов');
    expect(repo.listMemoryLines(1)).toEqual(['любит кофе', 'часовой пояс Bali']);
  });

  it('returns null for an out-of-range index and leaves memory intact', async () => {
    const repo = await freshRepo();
    repo.appendMemory(1, 'любит кофе');
    expect(repo.removeMemoryLine(1, 9)).toBeNull();
    expect(repo.removeMemoryLine(1, 0)).toBeNull();
    expect(repo.listMemoryLines(1)).toEqual(['любит кофе']);
  });
});
