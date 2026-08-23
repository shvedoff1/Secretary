import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The close pass end-to-end (with the cheap model mocked): quiet sessions become
// journal rows, the active tail is left alone, and a failed summarisation leaves
// everything unclosed for a later retry instead of losing the stretch.

const summarizeEpisodeMock = vi.hoisted(() => vi.fn());
vi.mock('../src/llm/episode.js', () => ({ summarizeEpisode: summarizeEpisodeMock }));

const MIN = 60_000;
const QUIET = 45 * MIN; // EPISODE_QUIET_MINUTES default

async function fresh() {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  vi.resetModules();
  summarizeEpisodeMock.mockReset();
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
  return {
    closer: await import('../src/episodes/closer.js'),
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

function seedSession(
  log: Awaited<ReturnType<typeof fresh>>['log'],
  chatId: number,
  startAt: number,
  lines: string[],
): number {
  lines.forEach((content, i) => {
    log.logMessage({
      chatId,
      role: 'user',
      tgUserId: 10 + i,
      senderName: `U${i}`,
      content,
      createdAt: startAt + i * MIN,
    });
  });
  return startAt + (lines.length - 1) * MIN;
}

describe('runDueEpisodes', () => {
  it('closes a quiet session into a journal row and advances the watermark', async () => {
    const { closer, repo, log } = await fresh();
    summarizeEpisodeMock.mockResolvedValue({ summary: 'обсуждали поездку', topics: ['поездка'] });
    const endAt = seedSession(log, 1, 1_000_000, ['а', 'б', 'в', 'г', 'д']);

    await closer.runDueEpisodes(endAt + QUIET + MIN);

    const episodes = repo.listEpisodes(1);
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({
      startedAt: 1_000_000,
      endedAt: endAt,
      messageCount: 5,
      summary: 'обсуждали поездку',
      topics: ['поездка'],
    });
    expect(repo.lastEpisodeEnd(1)).toBe(endAt);
    // The transcript the model saw carries the actual lines.
    expect(summarizeEpisodeMock.mock.calls[0]![0]).toContain('U0: а');
  });

  it('leaves an active conversation open and closes it only once quiet', async () => {
    const { closer, repo, log } = await fresh();
    summarizeEpisodeMock.mockResolvedValue({ summary: 's', topics: [] });
    const endAt = seedSession(log, 1, 1_000_000, ['а', 'б', 'в', 'г']);

    await closer.runDueEpisodes(endAt + MIN); // chat still "live"
    expect(repo.episodeCount(1)).toBe(0);

    await closer.runDueEpisodes(endAt + QUIET);
    expect(repo.episodeCount(1)).toBe(1);
  });

  it('closes only the finished session when a new one is already running', async () => {
    const { closer, repo, log } = await fresh();
    summarizeEpisodeMock.mockResolvedValue({ summary: 'первая беседа', topics: [] });
    const firstEnd = seedSession(log, 1, 1_000_000, ['а', 'б', 'в', 'г']);
    const secondStart = firstEnd + 2 * QUIET;
    const secondEnd = seedSession(log, 1, secondStart, ['х', 'у', 'ж', 'з']);

    await closer.runDueEpisodes(secondEnd + MIN); // second session still live

    const episodes = repo.listEpisodes(1);
    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.endedAt).toBe(firstEnd);
  });

  it('keeps the session unclosed on a failed summarisation and retries after backoff', async () => {
    const { closer, repo, log } = await fresh();
    summarizeEpisodeMock.mockResolvedValue(null); // model down
    const endAt = seedSession(log, 1, 1_000_000, ['а', 'б', 'в', 'г']);
    const now = endAt + QUIET + MIN;

    await closer.runDueEpisodes(now);
    expect(repo.episodeCount(1)).toBe(0);

    // Model recovers, but the backoff window still holds — no immediate retry.
    summarizeEpisodeMock.mockResolvedValue({ summary: 's', topics: [] });
    await closer.runDueEpisodes(now + MIN);
    expect(repo.episodeCount(1)).toBe(0);

    // Past the backoff (EPISODE_RETRY_MINUTES default 30) the close succeeds.
    await closer.runDueEpisodes(now + 31 * MIN);
    expect(repo.episodeCount(1)).toBe(1);
  });

  it('does nothing when episodes are disabled', async () => {
    const { log } = await fresh();
    process.env.ENABLE_EPISODES = 'false';
    vi.resetModules();
    const { migrate } = await import('../src/db/migrate.js');
    migrate();
    const closer = await import('../src/episodes/closer.js');
    const repo = await import('../src/db/repos/episode.repo.js');
    const freshLog = await import('../src/db/repos/chatLog.repo.js');
    const endAt = seedSession(freshLog, 1, 1_000_000, ['а', 'б', 'в', 'г']);
    await closer.runDueEpisodes(endAt + 2 * QUIET);
    expect(repo.episodeCount(1)).toBe(0);
    expect(summarizeEpisodeMock).not.toHaveBeenCalled();
    delete process.env.ENABLE_EPISODES;
    void log;
  });
});
