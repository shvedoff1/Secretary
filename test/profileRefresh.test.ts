import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The refresh orchestration: episode close hands the cards + notes + facts to the
// (mocked) cheap model and upserts only what it returned; a failed call keeps the
// old cards; the whole thing rides episode close in the closer.

const refreshProfileCardsMock = vi.hoisted(() => vi.fn());
vi.mock('../src/llm/profile.js', async (importOriginal) => {
  const real = (await importOriginal()) as object;
  return { ...real, refreshProfileCards: refreshProfileCardsMock };
});
const summarizeEpisodeMock = vi.hoisted(() => vi.fn());
vi.mock('../src/llm/episode.js', () => ({ summarizeEpisode: summarizeEpisodeMock }));

const MIN = 60_000;
const QUIET = 45 * MIN;

async function fresh() {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  vi.resetModules();
  refreshProfileCardsMock.mockReset();
  summarizeEpisodeMock.mockReset();
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
  return {
    refresh: await import('../src/episodes/profileRefresh.js'),
    closer: await import('../src/episodes/closer.js'),
    profiles: await import('../src/db/repos/profile.repo.js'),
    memory: await import('../src/db/repos/memoryItem.repo.js'),
    log: await import('../src/db/repos/chatLog.repo.js'),
    episodes: await import('../src/db/repos/episode.repo.js'),
  };
}

let closeDb: () => void;
beforeEach(async () => {
  ({ closeDb } = await import('../src/db/client.js'));
});
afterEach(() => {
  if (closeDb) closeDb();
});

const episode = (over: Record<string, unknown> = {}) => ({
  id: 1,
  chatId: 1,
  startedAt: 1000,
  endedAt: 2000,
  messageCount: 10,
  summary: 'обсуждали поездку',
  topics: ['поездка'],
  createdAt: 0,
  ...over,
});

describe('refreshProfilesForChat', () => {
  it('upserts the cards the model returned and feeds it cards + notes + facts', async () => {
    const { refresh, profiles, memory } = await fresh();
    profiles.upsertProfile(1, 'Гоша', 'старая карточка');
    memory.insertPinned(1, 'Гоша серфит', { scope: 'user', subject: 'Гоша', tgUserId: 10 });
    refreshProfileCardsMock.mockResolvedValue([
      { subject: '', content: 'чат готовит поездку' },
      { subject: 'Гоша', content: 'серфит; сейчас во Вьетнаме' },
    ]);

    await refresh.refreshProfilesForChat(1, [episode()]);

    const input = refreshProfileCardsMock.mock.calls[0]![0];
    expect(input.cards).toEqual([{ subject: 'Гоша', content: 'старая карточка' }]);
    expect(input.episodeNotes[0]).toContain('обсуждали поездку');
    expect(input.episodeNotes[0]).toContain('поездка');
    expect(input.facts.join('\n')).toContain('Гоша серфит');

    const stored = profiles.listProfiles(1);
    expect(stored.map((c) => [c.subject, c.content])).toEqual([
      ['', 'чат готовит поездку'],
      ['Гоша', 'серфит; сейчас во Вьетнаме'],
    ]);
  });

  it('keeps the old cards when the model call fails', async () => {
    const { refresh, profiles } = await fresh();
    profiles.upsertProfile(1, 'Гоша', 'старая карточка');
    refreshProfileCardsMock.mockResolvedValue(null);
    await refresh.refreshProfilesForChat(1, [episode()]);
    expect(profiles.listProfiles(1).map((c) => c.content)).toEqual(['старая карточка']);
  });

  it('does nothing when disabled or when nothing closed', async () => {
    const { refresh } = await fresh();
    await refresh.refreshProfilesForChat(1, []);
    process.env.ENABLE_PROFILES = 'false';
    vi.resetModules();
    const again = await import('../src/episodes/profileRefresh.js');
    await again.refreshProfilesForChat(1, [episode()]);
    delete process.env.ENABLE_PROFILES;
    expect(refreshProfileCardsMock).not.toHaveBeenCalled();
  });

  it('is driven by episode close in the closer', async () => {
    const { closer, profiles, log } = await fresh();
    summarizeEpisodeMock.mockResolvedValue({ summary: 'беседа', topics: [] });
    refreshProfileCardsMock.mockResolvedValue([{ subject: '', content: 'карточка чата' }]);
    const start = 1_000_000;
    ['а', 'б', 'в', 'г'].forEach((content, i) => {
      log.logMessage({
        chatId: 1,
        role: 'user',
        tgUserId: 10 + i,
        senderName: `U${i}`,
        content,
        createdAt: start + i * MIN,
      });
    });

    await closer.runDueEpisodes(start + 3 * MIN + QUIET + MIN);

    expect(refreshProfileCardsMock).toHaveBeenCalledOnce();
    expect(profiles.listProfiles(1).map((c) => c.content)).toEqual(['карточка чата']);
  });
});

describe('profile repo', () => {
  it('folds subjects case-insensitively and keeps the chat card first', async () => {
    const { profiles } = await fresh();
    profiles.upsertProfile(1, 'Гоша', 'v1');
    profiles.upsertProfile(1, 'гоша', 'v2');
    profiles.upsertProfile(1, '', 'карточка чата');
    const cards = profiles.listProfiles(1);
    expect(cards).toHaveLength(2);
    expect(cards[0]!.subject).toBe('');
    expect(cards[1]!.content).toBe('v2');
    expect(profiles.profileCount(1)).toBe(2);
    profiles.clearProfiles(1);
    expect(profiles.profileCount(1)).toBe(0);
  });
});
