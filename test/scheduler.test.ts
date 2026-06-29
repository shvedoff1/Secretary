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

describe('runDueTasks humor toggle', () => {
  afterEach(() => {
    responses = [];
    vi.unstubAllGlobals();
    delete process.env.ENABLE_HUMOR;
    delete process.env.OPENAI_API_KEY;
  });

  // A fake bot that records the text passed to sendMessage.
  function fakeBot(sent: string[]) {
    return {
      api: {
        sendMessage: async (_chatId: number, text: string) => {
          sent.push(text);
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

  it('humorizes a plain-chat reply when the task opted in', async () => {
    const scheduler = await seedDueTask(true);
    stubHumorizer();
    responses = [textResponse('Привет!')];

    const sent: string[] = [];
    await scheduler.runDueTasks(fakeBot(sent));

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('РОФЛ-вариант');
    expect(sent[0]).not.toContain('Привет!');
  });

  it('leaves the reply verbatim when the task did not opt in', async () => {
    const scheduler = await seedDueTask(false);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    responses = [textResponse('Привет!')];

    const sent: string[] = [];
    await scheduler.runDueTasks(fakeBot(sent));

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('Привет!');
    // Humour off for this task => OpenAI is never called.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
