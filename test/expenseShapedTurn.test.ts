import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Context } from 'grammy';

// An ADDRESSED turn that is SHAPED like a spend runs memory-free. The voice note
// «264, Замаг-Шнекнекс, раздели-ка на нас» came back as «судя по журналу это уже
// новая покупка метро от 5 сентября» — the expense's TITLE was lifted from the
// conversation journal and the dedup reasoning narrated out loud. The prompt rules
// are a fence; this is the wall: the deterministic trigger decides before the call,
// and a matching turn gets no facts, no profile cards, no journal (and no
// recall/summarize tools — see expenseOnlyAssistant.test.ts), while a plain
// addressed question in the same chat keeps all of it. When the regex stays
// quiet, the cheap classifier gets the say — and only where Splid is connected,
// since without record_expense there is nothing to protect.

const classifyMock = vi.fn(async (): Promise<'expense' | 'other' | 'unknown'> => 'other');
vi.mock('../src/llm/expenseClassify.js', () => ({
  classifyExpenseIntent: (...a: unknown[]) => classifyMock(...(a as [])),
}));

const runAssistantMock = vi.fn(async () => ({
  kind: 'text' as const,
  text: 'ничего',
  humorizable: true,
}));

vi.mock('../src/llm/assistant.js', () => ({ runAssistant: runAssistantMock }));

const CHAT = -555;

async function load(opts: { splid?: boolean } = {}) {
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
  if (opts.splid !== false) {
    const { setProviderGroup } = await import('../src/db/repos/chatConfig.repo.js');
    setProviderGroup({
      chatId: CHAT,
      providerName: 'splid',
      credential: 'code',
      providerGroupId: 'g1',
      defaultCurrency: 'EUR',
      createdBy: 1,
    });
  }
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

beforeEach(() => {
  runAssistantMock.mockClear();
  classifyMock.mockClear();
  classifyMock.mockImplementation(async () => 'other');
});
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
    // The regex decided — no classifier call was needed.
    expect(classifyMock).not.toHaveBeenCalled();
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
    // The regex stayed quiet, so the classifier was asked — and said no.
    expect(classifyMock).toHaveBeenCalledTimes(1);
    expect(call.memoryChat).toEqual([{ content: 'едем на Бали в марте' }]);
    expect(call.memoryTotal).toBe(2);
    expect(call.episodes).toHaveLength(1);
    expect(call.episodes![0]).toContain('метро');
    expect(call.profiles).toHaveLength(1);
  });
});

describe('runAndRespond: the classifier decides where the regex is quiet', () => {
  const ask = async (assist: Awaited<ReturnType<typeof load>>['assist'], text: string) =>
    assist.runAndRespond(ctx(), {
      userContent: text,
      addressed: true,
      source: 'voice',
      historyText: `[голос] ${text}`,
      manageReaction: false,
    });

  it('goes memory-free on an expense verdict for a numberless spend', async () => {
    const { assist } = await load();
    classifyMock.mockImplementation(async () => 'expense');
    await ask(assist, 'скинь Ване за ужин');

    const call = assistantCall();
    expect(call.memoryFree).toBe(true);
    expect(call.memoryChat).toEqual([]);
    expect(call.episodes).toEqual([]);
    expect(call.profiles).toEqual([]);
    // What the classifier saw: the message, the roster, recent turns — never memory.
    const seen = classifyMock.mock.calls[0]![0] as unknown as {
      text: string;
      senderName: string;
      source: string;
      members: string[];
      recent: string[];
    };
    expect(seen.text).toContain('скинь Ване за ужин');
    expect(seen.senderName).toBe('Андрей Шведов');
    expect(seen.source).toBe('voice');
    expect(Object.keys(seen).sort()).toEqual(['members', 'recent', 'senderName', 'source', 'text']);
  });

  it('fails open: an unknown verdict keeps every memory tier', async () => {
    const { assist } = await load();
    classifyMock.mockImplementation(async () => 'unknown');
    await ask(assist, 'скинь Ване за ужин');

    const call = assistantCall();
    expect(call.memoryFree).toBe(false);
    expect(call.memoryChat).toHaveLength(1);
    expect(call.episodes).toHaveLength(1);
  });

  it('is not consulted without a Splid group — nothing to protect there', async () => {
    const { assist } = await load({ splid: false });
    await ask(assist, 'такси 500 на всех');

    expect(classifyMock).not.toHaveBeenCalled();
    // The regex gate is off too: no record_expense, so memory may stay.
    expect(assistantCall().memoryFree).toBe(false);
  });

  it('is off with ENABLE_EXPENSE_CLASSIFIER=false (the regex gate alone decides)', async () => {
    process.env.ENABLE_EXPENSE_CLASSIFIER = 'false';
    try {
      const { assist } = await load();
      classifyMock.mockImplementation(async () => 'expense');
      await ask(assist, 'скинь Ване за ужин');
      expect(classifyMock).not.toHaveBeenCalled();
      expect(assistantCall().memoryFree).toBe(false);
    } finally {
      delete process.env.ENABLE_EXPENSE_CLASSIFIER;
    }
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
