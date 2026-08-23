import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

async function fresh() {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  vi.resetModules();
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
  return {
    repo: await import('../src/db/repos/episode.repo.js'),
    log: await import('../src/db/repos/chatLog.repo.js'),
  };
}

let closeDb: () => void;
beforeEach(async () => {
  ({ closeDb } = await import('../src/db/client.js'));
});
afterEach(() => {
  if (closeDb) closeDb();
});

describe('episode repo', () => {
  it('round-trips an episode with its topics', async () => {
    const { repo } = await fresh();
    repo.insertEpisode({
      chatId: 1,
      startedAt: 1000,
      endedAt: 2000,
      messageCount: 12,
      summary: 'обсуждали поездку\nГоша ищет доску',
      topics: ['поездка', ' серф ', ''],
    });
    const [ep] = repo.listEpisodes(1);
    expect(ep).toMatchObject({
      chatId: 1,
      startedAt: 1000,
      endedAt: 2000,
      messageCount: 12,
      summary: 'обсуждали поездку\nГоша ищет доску',
      topics: ['поездка', 'серф'],
    });
  });

  it('tracks the close watermark per chat', async () => {
    const { repo } = await fresh();
    expect(repo.lastEpisodeEnd(1)).toBe(0);
    repo.insertEpisode({ chatId: 1, startedAt: 1, endedAt: 500, messageCount: 4, summary: 'a', topics: [] });
    repo.insertEpisode({ chatId: 1, startedAt: 600, endedAt: 900, messageCount: 4, summary: 'b', topics: [] });
    repo.insertEpisode({ chatId: 2, startedAt: 1, endedAt: 9999, messageCount: 4, summary: 'c', topics: [] });
    expect(repo.lastEpisodeEnd(1)).toBe(900);
  });

  it('returns the newest episodes in chronological order', async () => {
    const { repo } = await fresh();
    for (let i = 1; i <= 4; i++) {
      repo.insertEpisode({ chatId: 1, startedAt: i * 100, endedAt: i * 100 + 50, messageCount: 4, summary: `s${i}`, topics: [] });
    }
    expect(repo.recentEpisodes(1, 2).map((e) => e.summary)).toEqual(['s3', 's4']);
    expect(repo.episodeCount(1)).toBe(4);
  });

  it('lists candidate chats with log messages beyond the watermark', async () => {
    const { repo, log } = await fresh();
    log.logMessage({ chatId: 1, role: 'user', tgUserId: 10, senderName: 'A', content: 'старое', createdAt: 100 });
    log.logMessage({ chatId: 1, role: 'user', tgUserId: 10, senderName: 'A', content: 'новое', createdAt: 900 });
    log.logMessage({ chatId: 2, role: 'user', tgUserId: 20, senderName: 'B', content: 'всё закрыто', createdAt: 300 });
    repo.insertEpisode({ chatId: 1, startedAt: 50, endedAt: 200, messageCount: 4, summary: 'x', topics: [] });
    repo.insertEpisode({ chatId: 2, startedAt: 50, endedAt: 300, messageCount: 4, summary: 'y', topics: [] });
    // Chat 1 has an unclosed message (900 > 200); chat 2's log is fully covered.
    expect(repo.episodeCandidates()).toEqual([{ chatId: 1, newestAt: 900, watermark: 200 }]);
  });

  it('prunes the oldest overflow and clears per chat', async () => {
    const { repo } = await fresh();
    for (let i = 1; i <= 5; i++) {
      repo.insertEpisode({ chatId: 1, startedAt: i, endedAt: i * 10, messageCount: 4, summary: `s${i}`, topics: [] });
    }
    repo.pruneEpisodes(1, 2);
    expect(repo.listEpisodes(1).map((e) => e.summary)).toEqual(['s4', 's5']);
    repo.clearEpisodes(1);
    expect(repo.episodeCount(1)).toBe(0);
  });
});
