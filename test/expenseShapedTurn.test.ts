import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Context } from 'grammy';

// An ADDRESSED turn that is SHAPED like a spend runs memory-free. The voice note
// «264, Замаг-Шнекнекс, раздели-ка на нас» came back as «судя по журналу это уже
// новая покупка метро от 5 сентября» — the expense's TITLE was lifted from the
// conversation journal and the dedup reasoning narrated out loud. The prompt rules
// are a fence; this is the wall: the deterministic trigger decides before the call,
// and a matching turn gets no facts, no profile cards, no journal (and no
// recall/summarize tools — see expenseOnlyAssistant.test.ts), while a plain
// addressed question in the same chat keeps all of it.

const runAssistantMock = vi.fn(async () => ({
  kind: 'text' as const,
  text: 'ничего',
  humorizable: true,
}));

vi.mock('../src/llm/assistant.js', () => ({ runAssistant: runAssistantMock }));

const CHAT = -555;

async function load() {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  delete process.env.OPENAI_API_KEY;
  vi.resetModules();
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
  const memory = await import('../src/db/repos/memoryItem.repo.js');
  const episodes = await import('../src/db/repos/episode.repo.js');
  const profiles = await import('../src/db/repos/profile.repo.js');
  // The chat "knows" things on every tier: a fact, a journal entry that
  // summarises a past expense, and a profile card naming a person.
  memory.insertPinned(CHAT, 'едем на Бали в марте');
  memory.insertPinned(CHAT, 'Швед — это я', { scope: 'user', subject: 'Андрей Шведов', tgUserId: 7 });
  episodes.insertEpisode({
    chatId: CHAT,
    startedAt: Date.now() - 3_600_000,
    endedAt: Date.now() - 1_800_000,
    messageCount: 5,
    summary: 'Иван записал трату на метро 300, бот подтвердил',
    topics: ['метро', 'траты'],
  });
  profiles.upsertProfile(CHAT, 'Иван', 'часто платит за транспорт');
  return { assist: await import('../src/bot/flows/assist.js'), triggers: await import('../src/bot/triggers.js') };
}

function ctx(): Context {
  return {
    chat: { id: CHAT, type: 'group', title: 'Чат' },
    from: { id: 7, first_name: 'Андрей', last_name: 'Шведов' },
    message: { message_id: 3 },
    react: async () => {},
    replyWithChatAction: async () => {},
    reply: async () => ({}),
    api: {
      sendRichMessage: async () => ({}),
      sendMessage: async () => ({}),
    },
  } as unknown as Context;
}

function assistantCall() {
  return runAssistantMock.mock.calls[0]![0] as unknown as {
    expenseOnly?: boolean;
    memoryFree?: boolean;
    memoryChat?: { content: string }[];
    memoryUsers?: unknown[];
    memoryTotal?: number;
    episodes?: string[];
    episodeTotal?: number;
    memoryTopics?: string[];
    profiles?: unknown[];
  };
}

beforeEach(() => runAssistantMock.mockClear());
afterEach(async () => {
  const { closeDb } = await import('../src/db/client.js');
  closeDb();
});

describe('runAndRespond: memory-free on an addressed, spend-shaped turn', () => {
  it('drops facts, journal and profiles for a voice note that splits an amount', async () => {
    const { assist } = await load();
    const transcript = '264, Замаг-Шнекнекс, раздели-ка на нас.';
    await assist.runAndRespond(ctx(), {
      userContent: transcript,
      addressed: true,
      source: 'voice',
      historyText: `[голос] ${transcript}`,
      manageReaction: false,
    });

    const call = assistantCall();
    expect(call.memoryFree).toBe(true);
    // Still an addressed turn: the toolset is NOT cut to record_expense.
    expect(call.expenseOnly).toBe(false);
    expect(call.memoryChat).toEqual([]);
    expect(call.memoryUsers).toEqual([]);
    expect(call.memoryTotal).toBe(0);
    expect(call.episodes).toEqual([]);
    expect(call.episodeTotal).toBe(0);
    expect(call.memoryTopics).toEqual([]);
    expect(call.profiles).toEqual([]);
  });

  it('drops them for a typed spend and for a receipt photo captioned with a split', async () => {
    const { assist } = await load();
    await assist.runAndRespond(ctx(), {
      userContent: 'Скай, такси 500 на всех',
      addressed: true,
      source: 'text',
      historyText: 'Скай, такси 500 на всех',
    });
    expect(assistantCall().memoryFree).toBe(true);

    runAssistantMock.mockClear();
    await assist.runAndRespond(ctx(), {
      userContent: [{ type: 'text', text: 'раздели на нас' }],
      addressed: true,
      source: 'photo',
      historyText: '[фото] раздели на нас',
    });
    expect(assistantCall().memoryFree).toBe(true);
    expect(assistantCall().episodes).toEqual([]);
  });

  it('keeps every tier for a plain addressed question in the same chat', async () => {
    const { assist } = await load();
    await assist.runAndRespond(ctx(), {
      userContent: 'Скай, куда мы едем?',
      addressed: true,
      source: 'text',
      historyText: 'Скай, куда мы едем?',
    });

    const call = assistantCall();
    expect(call.memoryFree).toBe(false);
    expect(call.memoryChat).toEqual([{ content: 'едем на Бали в марте' }]);
    expect(call.memoryTotal).toBe(2);
    expect(call.episodes).toHaveLength(1);
    expect(call.episodes![0]).toContain('метро');
    expect(call.profiles).toHaveLength(1);
  });
});

describe('isExpenseShaped', () => {
  it('matches spend reports and numbered split phrasing; photos need no number', async () => {
    const { triggers } = await load();
    const shaped = (text: string, source = 'text') =>
      triggers.isExpenseShaped({ chatId: CHAT, text, source });
    expect(shaped('264, Замаг-Шнекнекс, раздели-ка на нас.', 'voice')).toBe(true);
    expect(shaped('такси 500 на всех')).toBe(true);
    expect(shaped('заплатил 1200 за ужин')).toBe(true);
    expect(shaped('раздели на нас', 'photo')).toBe(true);
    expect(shaped('за меня и Колю', 'photo')).toBe(true);
  });

  it('leaves questions and chatter with their memory', async () => {
    const { triggers } = await load();
    const shaped = (text: string, source = 'text') =>
      triggers.isExpenseShaped({ chatId: CHAT, text, source });
    expect(shaped('Скай, куда мы едем?')).toBe(false);
    // Split-like phrasing without an amount is chatter on the text path.
    expect(shaped('он на нас наорал')).toBe(false);
    expect(shaped('раздели на нас')).toBe(false);
    // A number alone is not a spend.
    expect(shaped('встречаемся в 19:30')).toBe(false);
  });
});
