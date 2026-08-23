import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Queue of fake Anthropic responses; each runAssistant iteration shifts one.
let responses: unknown[] = [];
const createMock = vi.fn(async () => responses.shift());

vi.mock('../src/llm/client.js', () => ({
  getAnthropic: () => ({ messages: { create: createMock } }),
}));

function textResponse(text: string) {
  return {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text }],
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

// Spin up a fresh in-memory DB per test, returning the scheduler module (which
// reads memory back through the repo) plus the memory repo for seeding.
async function freshModules() {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  vi.resetModules();
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
  const scheduler = await import('../src/scheduler.js');
  const memory = await import('../src/db/repos/memoryItem.repo.js');
  const { loadConfig } = await import('../src/config.js');
  return { scheduler, memory, cfg: loadConfig() };
}

let closeDb: () => void;
beforeEach(async () => {
  ({ closeDb } = await import('../src/db/client.js'));
});
afterEach(() => {
  if (closeDb) closeDb();
});

describe('scheduledMemory', () => {
  it('pulls shared chat facts so a scheduled task is not memory-blind', async () => {
    const { scheduler, memory, cfg } = await freshModules();
    memory.recordMemoryItems(1, [
      { scope: 'chat', tgUserId: null, subject: '', content: 'едут на Бали в июле', importance: 5 },
      { scope: 'chat', tgUserId: null, subject: '', content: 'любят серфить на Улувату', importance: 4 },
    ]);

    const { memoryChat, memoryUsers } = scheduler.scheduledMemory(1, 100, cfg);

    expect(memoryChat.map((i) => i.content)).toEqual(
      expect.arrayContaining(['едут на Бали в июле', 'любят серфить на Улувату']),
    );
    expect(memoryUsers).toEqual([]);
  });

  it('includes the task creator’s per-person facts as the sender', async () => {
    const { scheduler, memory, cfg } = await freshModules();
    memory.recordMemoryItems(1, [
      { scope: 'chat', tgUserId: null, subject: '', content: 'чат про серф', importance: 4 },
      { scope: 'user', tgUserId: 100, subject: 'Sky', content: 'Sky любит лонгборд', importance: 5 },
      { scope: 'user', tgUserId: 200, subject: 'Max', content: 'Max боится больших волн', importance: 5 },
    ]);

    const { memoryChat, memoryUsers } = scheduler.scheduledMemory(1, 100, cfg);

    expect(memoryChat.map((i) => i.content)).toContain('чат про серф');
    // Only the creator (sender) shows up; with no recent conversation, other
    // participants are not surfaced.
    expect(memoryUsers).toHaveLength(1);
    expect(memoryUsers[0]!.subject).toBe('Sky');
    expect(memoryUsers[0]!.items.map((i) => i.content)).toEqual(['Sky любит лонгборд']);
  });

  it('returns chat memory even when the task has no creator (null tgUserId)', async () => {
    const { scheduler, memory, cfg } = await freshModules();
    memory.recordMemoryItems(1, [
      { scope: 'chat', tgUserId: null, subject: '', content: 'общий факт', importance: 5 },
      { scope: 'user', tgUserId: 100, subject: 'Sky', content: 'личный факт', importance: 5 },
    ]);

    const { memoryChat, memoryUsers } = scheduler.scheduledMemory(1, null, cfg);

    expect(memoryChat.map((i) => i.content)).toContain('общий факт');
    // No creator -> no per-person facts (sentinel sender matches nobody).
    expect(memoryUsers).toEqual([]);
  });

  it('returns empty sets for a chat with no memory', async () => {
    const { scheduler, cfg } = await freshModules();
    const { memoryChat, memoryUsers } = scheduler.scheduledMemory(999, 100, cfg);
    expect(memoryChat).toEqual([]);
    expect(memoryUsers).toEqual([]);
  });
});

describe('scheduledTurn', () => {
  it('prefixes the fired prompt with the scheduler marker and the task title', async () => {
    // Regression: «напомни оплатить подписку через 7 минут» fired as a bare
    // `scheduler: Оплатить подписку` turn, which the model read as a NEW request
    // to schedule a reminder and answered with clarifying questions — posted to
    // the chat as the reminder text.
    const { scheduler } = await freshModules();
    const { SCHEDULED_TASK_MARKER } = await import('../src/llm/prompts.js');

    const turn = scheduler.scheduledTurn(
      { title: 'Оплатить подписку', prompt: 'Напомни, что пора оплатить подписку', humor: false },
      [],
    );

    expect(turn).toBe(
      `${SCHEDULED_TASK_MARKER} «Оплатить подписку»\nНапомни, что пора оплатить подписку`,
    );
  });

  it('renders the bare marker when the task has no title', async () => {
    const { scheduler } = await freshModules();
    const { SCHEDULED_TASK_MARKER } = await import('../src/llm/prompts.js');
    const turn = scheduler.scheduledTurn({ title: '', prompt: 'Напомни про зал', humor: false }, []);
    expect(turn).toBe(`${SCHEDULED_TASK_MARKER}\nНапомни про зал`);
  });

  it('appends recent chatter only for a humour task', async () => {
    const { scheduler } = await freshModules();
    const recent = [{ name: 'Миша', text: 'антоха взял два чокопая' }];
    expect(scheduler.scheduledTurn({ title: 'Вайб', prompt: 'Пошути', humor: true }, recent)).toContain(
      'Миша: антоха взял два чокопая',
    );
    expect(
      scheduler.scheduledTurn({ title: 'Вайб', prompt: 'Пошути', humor: false }, recent),
    ).not.toContain('чокопая');
  });
});

describe('runDueTasks humor toggle', () => {
  afterEach(() => {
    responses = [];
    createMock.mockClear();
    vi.unstubAllGlobals();
    delete process.env.ENABLE_HUMOR;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ENABLE_SLANG;
  });

  // A fake bot that records every (chatId, text) passed to sendMessage.
  function fakeBot(sent: { chatId: number; text: string }[]) {
    return {
      api: {
        sendMessage: async (chatId: number, text: string) => {
          sent.push({ chatId, text });
        },
      },
    } as never;
  }

  // OpenAI humorizer returns a fixed "rewrite" so we can detect it ran.
  function stubHumorizer() {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: 'РОФЛ-вариант' } }] }),
          { status: 200 },
        ),
      ),
    );
  }

  async function seedDueTask(humor: boolean) {
    process.env.ENABLE_HUMOR = 'true';
    process.env.OPENAI_API_KEY = 'sk-test';
    const { scheduler } = await freshModules();
    const repo = await import('../src/db/repos/scheduledTask.repo.js');
    repo.createTask({
      chatId: 100,
      tgUserId: 1,
      title: 'Пинг',
      prompt: 'Скажи привет',
      cron: '0 9 * * *',
      timezone: 'Europe/Lisbon',
      once: true,
      humor,
      nextRunAt: 1, // due
    });
    return scheduler;
  }

  it('humorizes a plain-chat reply when the task opted in, and DMs the admin the "before"', async () => {
    const scheduler = await seedDueTask(true);
    stubHumorizer();
    responses = [textResponse('Привет!')];

    const sent: { chatId: number; text: string }[] = [];
    await scheduler.runDueTasks(fakeBot(sent));

    // The chat (100) gets the humorized text; the admin (1) gets the pre-OpenAI original.
    const chatMsg = sent.find((m) => m.chatId === 100);
    const adminDm = sent.find((m) => m.chatId === 1);
    expect(chatMsg?.text).toContain('РОФЛ-вариант');
    expect(chatMsg?.text).not.toContain('Привет!');
    expect(adminDm?.text).toContain('До OpenAI');
    expect(adminDm?.text).toContain('Привет!');
  });

  it('skips the humorizer when the CHAT has humor switched off, despite the task flag', async () => {
    const scheduler = await seedDueTask(true); // task itself opted in
    const { setChatHumorEnabled } = await import('../src/db/repos/chatSettings.repo.js');
    setChatHumorEnabled(100, false);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    responses = [textResponse('Привет!')];

    const sent: { chatId: number; text: string }[] = [];
    await scheduler.runDueTasks(fakeBot(sent));

    expect(sent).toHaveLength(1);
    expect(sent[0]!.chatId).toBe(100);
    expect(sent[0]!.text).toContain('Привет!');
    // The chat switch trumps the task flag: OpenAI never called, no admin DM.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves the reply verbatim (and sends no admin preview) when the task did not opt in', async () => {
    const scheduler = await seedDueTask(false);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    responses = [textResponse('Привет!')];

    const sent: { chatId: number; text: string }[] = [];
    await scheduler.runDueTasks(fakeBot(sent));

    expect(sent).toHaveLength(1);
    expect(sent[0]!.chatId).toBe(100);
    expect(sent[0]!.text).toContain('Привет!');
    // Humour off for this task => OpenAI is never called and no admin DM.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('runs the SLANG pass over a task that never opted into humour', async () => {
    // The point of the separate switch: a plain (non-humour) task still speaks
    // the chat's words. Humour off for the task, slang on for the chat.
    const scheduler = await seedDueTask(false);
    const lex = await import('../src/db/repos/lexicon.repo.js');
    lex.recordTerms(100, [{ term: 'катка', gloss: 'игра' }]);
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'Здарова, катка!' } }] }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    responses = [textResponse('Привет!')];

    const sent: { chatId: number; text: string }[] = [];
    await scheduler.runDueTasks(fakeBot(sent));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Slang pass only — no "before" DM to the admin (that's a humorizer thing).
    expect(sent).toHaveLength(1);
    expect(sent[0]!.chatId).toBe(100);
    expect(sent[0]!.text).toContain('Здарова, катка!');
  });

  it('keeps a factual reply intact when the slang rewrite moved a number', async () => {
    const scheduler = await seedDueTask(false);
    const lex = await import('../src/db/repos/lexicon.repo.js');
    lex.recordTerms(100, [{ term: 'катка', gloss: 'игра' }]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: 'Катка в 21:00' } }] }),
          { status: 200 },
        ),
      ),
    );
    responses = [textResponse('Игра в 20:00')];

    const sent: { chatId: number; text: string }[] = [];
    await scheduler.runDueTasks(fakeBot(sent));

    expect(sent[0]!.text).toContain('Игра в 20:00');
    expect(sent[0]!.text).not.toContain('21:00');
  });

  it('skips the slang pass when the chat has slang switched off', async () => {
    const scheduler = await seedDueTask(false);
    const lex = await import('../src/db/repos/lexicon.repo.js');
    lex.recordTerms(100, [{ term: 'катка', gloss: 'игра' }]);
    const { setChatSlangEnabled } = await import('../src/db/repos/chatSettings.repo.js');
    setChatSlangEnabled(100, false);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    responses = [textResponse('Привет!')];

    const sent: { chatId: number; text: string }[] = [];
    await scheduler.runDueTasks(fakeBot(sent));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(sent[0]!.text).toContain('Привет!');
  });

  it('does not re-tone a humorized reply (one pass, not two)', async () => {
    const scheduler = await seedDueTask(true);
    const lex = await import('../src/db/repos/lexicon.repo.js');
    lex.recordTerms(100, [{ term: 'катка', gloss: 'игра' }]);
    stubHumorizer();
    responses = [textResponse('Привет!')];

    const sent: { chatId: number; text: string }[] = [];
    await scheduler.runDueTasks(fakeBot(sent));

    // Exactly one OpenAI call: the humorizer already carried the lexicon.
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
    expect(sent.find((m) => m.chatId === 100)?.text).toContain('РОФЛ-вариант');
  });

  it('feeds recent chatter into a humour task so it can riff on context', async () => {
    process.env.ENABLE_HUMOR = 'false'; // not exercising the humorizer here
    const { scheduler } = await freshModules();
    const repo = await import('../src/db/repos/scheduledTask.repo.js');
    const recentChat = await import('../src/bot/recentChat.js');
    recentChat.recordChatMessage(100, 'Миша', 'антоха взял два чокопая');

    repo.createTask({
      chatId: 100,
      tgUserId: 1,
      title: 'Прогноз',
      prompt: 'Дай прогноз',
      cron: '0 9 * * *',
      timezone: 'Europe/Lisbon',
      once: true,
      humor: true,
      nextRunAt: 1,
    });
    responses = [textResponse('ok')];

    await scheduler.runDueTasks(fakeBot([]));

    // The recent line reaches the model as part of the user content.
    const firstCall = createMock.mock.calls[0]![0] as {
      messages: { role: string; content: unknown }[];
    };
    const lastUser = firstCall.messages[firstCall.messages.length - 1]!;
    expect(JSON.stringify(lastUser.content)).toContain('антоха взял два чокопая');
  });

  it('does NOT feed recent chatter into a non-humour task', async () => {
    process.env.ENABLE_HUMOR = 'false';
    const { scheduler } = await freshModules();
    const repo = await import('../src/db/repos/scheduledTask.repo.js');
    const recentChat = await import('../src/bot/recentChat.js');
    recentChat.recordChatMessage(100, 'Миша', 'секретная болтовня');

    repo.createTask({
      chatId: 100,
      tgUserId: 1,
      title: 'Напоминание',
      prompt: 'Напомни',
      cron: '0 9 * * *',
      timezone: 'Europe/Lisbon',
      once: true,
      humor: false,
      nextRunAt: 1,
    });
    responses = [textResponse('ok')];

    await scheduler.runDueTasks(fakeBot([]));

    const firstCall = createMock.mock.calls[0]![0] as {
      messages: { role: string; content: unknown }[];
    };
    const lastUser = firstCall.messages[firstCall.messages.length - 1]!;
    expect(JSON.stringify(lastUser.content)).not.toContain('секретная болтовня');
  });

  it('sends the marker-prefixed turn to the model when a task fires', async () => {
    process.env.ENABLE_HUMOR = 'false';
    const { scheduler } = await freshModules();
    const repo = await import('../src/db/repos/scheduledTask.repo.js');
    const { SCHEDULED_TASK_MARKER } = await import('../src/llm/prompts.js');
    repo.createTask({
      chatId: 100,
      tgUserId: 1,
      title: 'Оплатить подписку',
      prompt: 'Напомни, что пора оплатить подписку',
      cron: '0 9 * * *',
      timezone: 'Europe/Lisbon',
      once: true,
      humor: false,
      nextRunAt: 1,
    });
    responses = [textResponse('пора оплатить подписку!')];

    await scheduler.runDueTasks(fakeBot([]));

    const firstCall = createMock.mock.calls[0]![0] as {
      messages: { role: string; content: unknown }[];
    };
    const lastUser = JSON.stringify(firstCall.messages[firstCall.messages.length - 1]!.content);
    expect(lastUser).toContain(SCHEDULED_TASK_MARKER);
    expect(lastUser).toContain('Напомни, что пора оплатить подписку');
  });

  it('records the fired task post into conversation history for follow-ups', async () => {
    // Regression: a recurring post ("⏰ Прогноз …") was sent but never stored, so a
    // later «обнови прогноз» reached the assistant with no idea what was posted.
    process.env.ENABLE_HUMOR = 'false';
    const { scheduler } = await freshModules();
    const repo = await import('../src/db/repos/scheduledTask.repo.js');
    const convo = await import('../src/db/repos/conversation.repo.js');
    repo.createTask({
      chatId: 100,
      tgUserId: 1,
      title: 'Прогноз',
      prompt: 'Дай прогноз',
      cron: '0 9 * * *',
      timezone: 'Europe/Lisbon',
      once: true,
      humor: false,
      nextRunAt: 1,
    });
    responses = [textResponse('волны 1.2м в Чангу')];

    await scheduler.runDueTasks(fakeBot([]));

    const history = convo.recentTurns(100, 20);
    expect(history).toHaveLength(1);
    expect(history[0]!.role).toBe('assistant');
    expect(history[0]!.content).toContain('⏰ Прогноз');
    expect(history[0]!.content).toContain('волны 1.2м в Чангу');
  });
});
