import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// recall_memory over the deep tier's episodic half: one search reaches remembered
// facts AND the journal of past conversations, with the verbatim-expansion path
// (summarize_chat + dates) named in the result.

async function freshChat() {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  process.env.ENABLE_MEMORY = 'true';
  vi.resetModules();
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
  return {
    memory: await import('../src/db/repos/memoryItem.repo.js'),
    episodes: await import('../src/db/repos/episode.repo.js'),
    recall: (await import('../src/bot/flows/assist.js')).makeRecallMemoryHandler(1),
  };
}

let closeDb: () => void;
beforeEach(async () => {
  ({ closeDb } = await import('../src/db/client.js'));
});
afterEach(() => {
  if (closeDb) closeDb();
  delete process.env.ENABLE_MEMORY;
});

const at = (iso: string): number => Date.parse(iso);

describe('recall_memory over the conversation journal', () => {
  it('returns journal notes alongside facts, with the summarize_chat pointer', async () => {
    const { memory, episodes, recall } = await freshChat();
    memory.insertPinned(1, 'Гоша хочет новую доску');
    episodes.insertEpisode({
      chatId: 1,
      startedAt: at('2026-08-20T18:00:00Z'),
      endedAt: at('2026-08-20T20:00:00Z'),
      messageCount: 30,
      summary: 'выбирали доску для Гоши, спорили о размере',
      topics: ['серф'],
    });

    const out = recall({ query: 'доску', about: null });
    expect(out).toContain('Гоша хочет новую доску');
    expect(out).toContain('журнала бесед');
    expect(out).toContain('выбирали доску для Гоши');
    expect(out).toContain('2026-08-20');
    expect(out).toContain('summarize_chat');
  });

  it('serves a journal-only hit when no fact matches', async () => {
    const { episodes, recall } = await freshChat();
    episodes.insertEpisode({
      chatId: 1,
      startedAt: at('2026-08-20T18:00:00Z'),
      endedAt: at('2026-08-20T20:00:00Z'),
      messageCount: 30,
      summary: 'договорились ехать на рыбалку в субботу',
      topics: ['рыбалка'],
    });

    const out = recall({ query: 'рыбалка', about: null });
    expect(out).toContain('в журнале бесед есть подходящее');
    expect(out).toContain('рыбалку в субботу');
  });

  it('keeps the honest empty answer when neither tier matches', async () => {
    const { memory, recall } = await freshChat();
    memory.insertPinned(1, 'у Андрея аллергия на арахис');
    const out = recall({ query: 'квантовая физика', about: null });
    expect(out).toContain('Ничего не нашёл');
    expect(out).not.toContain('журнал');
  });

  it('searches the journal by the about name when query is null', async () => {
    const { episodes, recall } = await freshChat();
    episodes.insertEpisode({
      chatId: 1,
      startedAt: at('2026-08-20T18:00:00Z'),
      endedAt: at('2026-08-20T20:00:00Z'),
      messageCount: 30,
      summary: 'Гоша рассказывал про новую работу',
      topics: [],
    });
    const out = recall({ query: null, about: 'Гоша' });
    expect(out).toContain('про новую работу');
  });
});
