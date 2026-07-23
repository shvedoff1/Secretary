import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vi } from 'vitest';

async function freshRepo() {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  vi.resetModules();
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
  return import('../src/db/repos/pingList.repo.js');
}

let closeDb: () => void;
afterEach(async () => {
  if (closeDb) closeDb();
});
beforeEach(async () => {
  ({ closeDb } = await import('../src/db/client.js'));
});

describe('ping list repo', () => {
  it('adds members and reads them back in insertion order', async () => {
    const repo = await freshRepo();
    const added = repo.addPingMembers(1, 'dota', ['@vasya', '@petya'], 42);
    expect(added).toEqual(['@vasya', '@petya']);
    expect(repo.getPingList(1, 'dota')).toEqual(['@vasya', '@petya']);
  });

  it('deduplicates case-insensitively, including Cyrillic tokens', async () => {
    const repo = await freshRepo();
    repo.addPingMembers(1, 'dota', ['@Vasya', 'Коля'], 42);
    const added = repo.addPingMembers(1, 'dota', ['@vasya', 'коля', '@new'], 42);
    expect(added).toEqual(['@new']);
    expect(repo.getPingList(1, 'dota')).toEqual(['@Vasya', 'Коля', '@new']);
  });

  it('skips duplicates within a single add call and blank tokens', async () => {
    const repo = await freshRepo();
    const added = repo.addPingMembers(1, 'dota', ['@a', '@A', '', '  '], 42);
    expect(added).toEqual(['@a']);
  });

  it('keeps many lists per chat and treats list names case-insensitively', async () => {
    const repo = await freshRepo();
    repo.addPingMembers(1, 'dota', ['@a'], 42);
    repo.addPingMembers(1, 'Стак', ['@b', '@c'], 42);
    expect(repo.getPingList(1, 'стак')).toEqual(['@b', '@c']);
    const lists = repo.listPingLists(1);
    expect(lists.map((l) => l.name).sort()).toEqual(['dota', 'стак']);
    expect(lists.find((l) => l.name === 'стак')!.members).toEqual(['@b', '@c']);
  });

  it('is isolated per chat', async () => {
    const repo = await freshRepo();
    repo.addPingMembers(1, 'dota', ['@a'], 42);
    expect(repo.getPingList(2, 'dota')).toEqual([]);
    expect(repo.listPingLists(2)).toEqual([]);
  });

  it('removes members case-insensitively and reports what was removed', async () => {
    const repo = await freshRepo();
    repo.addPingMembers(1, 'dota', ['@Vasya', '@petya'], 42);
    const removed = repo.removePingMembers(1, 'dota', ['@vasya', '@nobody']);
    expect(removed).toEqual(['@Vasya']);
    expect(repo.getPingList(1, 'dota')).toEqual(['@petya']);
  });

  it('clears a whole list and reports the member count', async () => {
    const repo = await freshRepo();
    repo.addPingMembers(1, 'смок', ['@a', '@b'], 42);
    expect(repo.clearPingList(1, 'смок')).toBe(2);
    expect(repo.getPingList(1, 'смок')).toEqual([]);
    expect(repo.clearPingList(1, 'смок')).toBe(0); // already gone
  });
});
