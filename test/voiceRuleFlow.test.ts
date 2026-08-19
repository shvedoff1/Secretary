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

function ctx(chatId = -777): Context {
  return {
    chat: { id: chatId, type: 'group', title: 'Чат' },
    from: { id: 5, first_name: 'Аня' },
    message: { message_id: 11 },
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
