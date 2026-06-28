import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

async function freshRepo() {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  vi.resetModules();
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
  return import('../src/db/repos/memoryItem.repo.js');
}

let closeDb: () => void;
afterEach(async () => {
  if (closeDb) closeDb();
});
beforeEach(async () => {
  ({ closeDb } = await import('../src/db/client.js'));
});

describe('memory sample buffer', () => {
  it('round-trips samples and preserves the sender', async () => {
    const repo = await freshRepo();
    repo.recordSample(1, 100, 'Sky', 'привет');
    repo.recordSample(1, 200, 'Max', 'ку');
    expect(repo.sampleStats(1).count).toBe(2);

    const claimed = repo.claimSamples(1);
    expect(claimed).toEqual([
      { tgUserId: 100, senderName: 'Sky', content: 'привет' },
      { tgUserId: 200, senderName: 'Max', content: 'ку' },
    ]);
    // Claiming deletes them.
    expect(repo.sampleStats(1).count).toBe(0);
  });
});

describe('memory store', () => {
  it('records passive items and clamps importance', async () => {
    const repo = await freshRepo();
    repo.recordMemoryItems(1, [
      { scope: 'user', tgUserId: 100, subject: 'Sky', content: 'любит серф', importance: 99 },
      { scope: 'chat', tgUserId: null, subject: '', content: 'едут на Бали', importance: 4 },
      { scope: 'chat', tgUserId: null, subject: '', content: '   ', importance: 3 },
    ]);
    const items = repo.getAllItems(1);
    expect(items).toHaveLength(2); // blank content skipped
    const sky = items.find((i) => i.content === 'любит серф')!;
    expect(sky.importance).toBe(5); // clamped from 99
    expect(sky.source).toBe('passive');
  });

  it('reinforces an item: bumps count, importance and last_seen', async () => {
    const repo = await freshRepo();
    repo.recordMemoryItems(1, [
      { scope: 'chat', tgUserId: null, subject: '', content: 'факт', importance: 3 },
    ]);
    const before = repo.getAllItems(1)[0]!;
    repo.reinforceItems(1, [before.id]);
    const after = repo.getAllItems(1)[0]!;
    expect(after.reinforce).toBe(1);
    expect(after.importance).toBeCloseTo(3.5, 6);
    expect(after.lastSeen).toBeGreaterThanOrEqual(before.lastSeen);
  });

  it('caps importance via reinforcement at 5', async () => {
    const repo = await freshRepo();
    repo.recordMemoryItems(1, [
      { scope: 'chat', tgUserId: null, subject: '', content: 'факт', importance: 5 },
    ]);
    const id = repo.getAllItems(1)[0]!.id;
    repo.reinforceItems(1, [id]);
    repo.reinforceItems(1, [id]);
    expect(repo.getAllItems(1)[0]!.importance).toBe(5);
  });

  it('pins explicit items, exempt from pruning', async () => {
    const repo = await freshRepo();
    repo.insertPinned(1, 'закреплённый факт');
    repo.recordMemoryItems(1, [
      { scope: 'chat', tgUserId: null, subject: '', content: 'p-high', importance: 5 },
      { scope: 'chat', tgUserId: null, subject: '', content: 'p-low', importance: 1 },
    ]);

    // Cap passive at 1 → the lower-weight passive item is pruned; pinned survives.
    repo.pruneMemory(1, 1, 14);
    const contents = repo.getAllItems(1).map((i) => i.content).sort();
    expect(contents).toEqual(['p-high', 'закреплённый факт']);
  });

  it('lists items for display pinned-first then by weight, and removes by id', async () => {
    const repo = await freshRepo();
    repo.recordMemoryItems(1, [
      { scope: 'chat', tgUserId: null, subject: '', content: 'low', importance: 1 },
      { scope: 'chat', tgUserId: null, subject: '', content: 'high', importance: 5 },
    ]);
    repo.insertPinned(1, 'pinned');

    const display = repo.listMemoryItemsForDisplay(1, 14);
    expect(display[0]).toMatchObject({ content: 'pinned', pinned: true });
    expect(display.slice(1).map((d) => d.content)).toEqual(['high', 'low']);

    const removed = repo.removeMemoryItem(1, display[1]!.id);
    expect(removed).toBe('high');
    expect(repo.getAllItems(1).map((i) => i.content).sort()).toEqual(['low', 'pinned']);
  });

  it('clears all items and buffered samples for a chat', async () => {
    const repo = await freshRepo();
    repo.insertPinned(1, 'x');
    repo.recordSample(1, 100, 'Sky', 'y');
    repo.clearMemoryItems(1);
    expect(repo.getAllItems(1)).toEqual([]);
    expect(repo.sampleStats(1).count).toBe(0);
  });

  it('builds a context selection split into chat and per-user sections', async () => {
    const repo = await freshRepo();
    repo.recordMemoryItems(1, [
      { scope: 'chat', tgUserId: null, subject: '', content: 'общий', importance: 5 },
      { scope: 'user', tgUserId: 100, subject: 'Sky', content: 'про меня', importance: 5 },
      { scope: 'user', tgUserId: 200, subject: 'Max', content: 'про макса', importance: 4 },
    ]);
    const sel = repo.getMemoryForContext(1, {
      senderTgUserId: 100,
      recentParticipantIds: [100, 200],
      halfLifeDays: 14,
      chatBudget: 8,
      userBudget: 6,
    });
    expect(sel.chat.map((i) => i.content)).toEqual(['общий']);
    expect(sel.users[0]!.tgUserId).toBe(100);
    expect(sel.users.map((u) => u.tgUserId)).toContain(200);
  });
});
