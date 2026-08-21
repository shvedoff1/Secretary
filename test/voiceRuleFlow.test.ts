import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Context } from 'grammy';

// A chat rule like «все голосовые очищай от слов-паразитов и скидывай расшифровку»
// can only work if the model can TELL a voice transcript from a typed message and
// can see the rule. Both halves are wired in runAndRespond, and both are asserted
// here against a mocked assistant (no LLM, no Telegram).

const runAssistantMock = vi.fn(async () => ({
  kind: 'text' as const,
  text: 'Готово.',
  humorizable: true,
}));

vi.mock('../src/llm/assistant.js', () => ({ runAssistant: runAssistantMock }));

async function load(env: Record<string, string> = {}) {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  delete process.env.OPENAI_API_KEY; // keeps the humorizer/slang passes out of the way
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  vi.resetModules();
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
  return {
    assist: await import('../src/bot/flows/assist.js'),
    rules: await import('../src/db/repos/chatRule.repo.js'),
  };
}

const sent: string[] = [];

function ctx(chatId = -777, message: Record<string, unknown> = {}): Context {
  return {
    chat: { id: chatId, type: 'group', title: 'Чат' },
    from: { id: 5, first_name: 'Аня' },
    message: { message_id: 11, ...message },
    react: async () => {},
    replyWithChatAction: async () => {},
    reply: async (t: string) => {
      sent.push(t);
      return {};
    },
    api: {
      sendRichMessage: async (_id: number, payload: { markdown: string }) => {
        sent.push(payload.markdown);
        return {};
      },
      sendMessage: async (_id: number, t: string) => {
        sent.push(t);
        return {};
      },
    },
  } as unknown as Context;
}

function assistantCall() {
  return runAssistantMock.mock.calls[0]![0] as unknown as {
    rules: string[];
    userContent: string;
    mode: string;
  };
}

beforeEach(() => {
  runAssistantMock.mockClear();
  sent.length = 0;
});
afterEach(async () => {
  const { closeDb } = await import('../src/db/client.js');
  closeDb();
});

describe('voice transcripts reaching the model', () => {
  it('marks a voice transcript so a rule can key on the channel', async () => {
    const { assist } = await load();
    const { VOICE_TRANSCRIPT_MARKER } = await import('../src/llm/prompts.js');

    await assist.runAndRespond(ctx(), {
      userContent: 'ну это, короче, купи молока',
      addressed: true,
      source: 'voice',
      historyText: '[голос] ну это, короче, купи молока',
    });

    const call = assistantCall();
    expect(call.userContent).toBe(`${VOICE_TRANSCRIPT_MARKER}\nну это, короче, купи молока`);
  });

  it('leaves a typed message untouched', async () => {
    const { assist } = await load();
    const { VOICE_TRANSCRIPT_MARKER } = await import('../src/llm/prompts.js');

    await assist.runAndRespond(ctx(), {
      userContent: 'купи молока',
      addressed: true,
      source: 'text',
      historyText: 'купи молока',
    });

    const call = assistantCall();
    expect(call.userContent).toBe('купи молока');
    expect(call.userContent).not.toContain(VOICE_TRANSCRIPT_MARKER);
  });
});

describe('forwarded messages reaching the model', () => {
  it('marks a forwarded message with its origin, so a rule can key on it', async () => {
    const { assist } = await load();
    const { FORWARDED_MESSAGE_MARKER } = await import('../src/llm/prompts.js');

    await assist.runAndRespond(
      ctx(-777, { forward_origin: { type: 'channel', chat: { title: 'Дуров пишет' } } }),
      {
        userContent: 'важная новость',
        addressed: true,
        source: 'text',
        historyText: 'важная новость',
      },
    );

    expect(assistantCall().userContent).toBe(
      `${FORWARDED_MESSAGE_MARKER} (источник: канал «Дуров пишет»)\nважная новость`,
    );
  });

  it('marks a forwarded VOICE note as both forwarded and transcribed', async () => {
    const { assist } = await load();
    const { FORWARDED_MESSAGE_MARKER, VOICE_TRANSCRIPT_MARKER } = await import(
      '../src/llm/prompts.js'
    );

    await assist.runAndRespond(ctx(-777, { forward_from: { first_name: 'Вася' } }), {
      userContent: 'ну это, короче, я купил молока',
      addressed: true,
      source: 'voice',
      historyText: '[голос] ну это, короче, я купил молока',
    });

    const content = assistantCall().userContent;
    expect(content).toContain(`${FORWARDED_MESSAGE_MARKER} (источник: Вася)`);
    expect(content).toContain(VOICE_TRANSCRIPT_MARKER);
    expect(content.endsWith('ну это, короче, я купил молока')).toBe(true);
  });

  it('prefixes a forwarded PHOTO turn with its own text block, keeping the image', async () => {
    const { assist } = await load();
    const { FORWARDED_MESSAGE_MARKER } = await import('../src/llm/prompts.js');
    const blocks = [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'x' } },
      { type: 'text', text: 'это чек' },
    ];

    await assist.runAndRespond(ctx(-777, { forward_from: { first_name: 'Вася' } }), {
      userContent: blocks as never,
      addressed: true,
      source: 'photo',
      historyText: '[чек] это чек',
    });

    const content = assistantCall().userContent as unknown as { type: string; text?: string }[];
    expect(content[0]).toEqual({
      type: 'text',
      text: `${FORWARDED_MESSAGE_MARKER} (источник: Вася)`,
    });
    expect(content).toHaveLength(3);
    expect(content[1]!.type).toBe('image');
  });

  it('tags the stored history turn, so the next turn still knows it was a forward', async () => {
    const { assist } = await load();
    const conversation = await import('../src/db/repos/conversation.repo.js');

    await assist.runAndRespond(ctx(-777, { forward_from: { first_name: 'Вася' } }), {
      userContent: 'я всё продал',
      addressed: true,
      source: 'text',
      historyText: 'я всё продал',
    });

    const turns = conversation.recentTurns(-777, 10, 60_000);
    expect(turns[0]).toMatchObject({ role: 'user', content: '[переслано] я всё продал' });
  });

  it('leaves a message written in the chat unmarked', async () => {
    const { assist } = await load();
    const { FORWARDED_MESSAGE_MARKER } = await import('../src/llm/prompts.js');
    const conversation = await import('../src/db/repos/conversation.repo.js');

    await assist.runAndRespond(ctx(), {
      userContent: 'я всё продал',
      addressed: true,
      source: 'text',
      historyText: 'я всё продал',
    });

    expect(assistantCall().userContent).toBe('я всё продал');
    expect(assistantCall().userContent).not.toContain(FORWARDED_MESSAGE_MARKER);
    expect(conversation.recentTurns(-777, 10, 60_000)[0]!.content).toBe('я всё продал');
  });
});

describe('chat rules reaching the model from the flow', () => {
  it('passes the chat’s standing rules into every turn', async () => {
    const { assist, rules } = await load();
    rules.addRule({
      chatId: -777,
      text: 'Все голосовые расшифровывай и чисти от слов-паразитов',
      max: 30,
    });
    rules.addRule({ chatId: -777, text: 'Отвечай короче', max: 30 });
    // Another chat's rules must not leak in.
    rules.addRule({ chatId: -888, text: 'Пиши по-английски', max: 30 });

    await assist.runAndRespond(ctx(), {
      userContent: 'привет',
      addressed: true,
      source: 'text',
      historyText: 'привет',
    });

    expect(assistantCall().rules).toEqual([
      'Все голосовые расшифровывай и чисти от слов-паразитов',
      'Отвечай короче',
    ]);
  });

  it('passes the chat mode through, so the persona matches the picked mode', async () => {
    const { assist } = await load();
    const settings = await import('../src/db/repos/chatSettings.repo.js');
    settings.setChatMode(-777, 'assistant');

    await assist.runAndRespond(ctx(), {
      userContent: 'привет',
      addressed: true,
      source: 'text',
      historyText: 'привет',
    });

    expect(assistantCall().mode).toBe('assistant');
  });
});
