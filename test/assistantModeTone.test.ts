import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Context } from 'grammy';

// The calm mode's whole point: no jokes, ever. The humour pass is gated by the
// chat's MODE on top of the global flag and the per-chat /humor switch, so a chat
// switched to «ассистент» stays deadpan even with humour fully enabled.

const humorizeMock = vi.fn(async (text: string) => `😂 ${text}`);

vi.mock('../src/llm/humorize.js', async () => {
  const actual = await vi.importActual<typeof import('../src/llm/humorize.js')>(
    '../src/llm/humorize.js',
  );
  return { ...actual, isHumorEnabled: () => true, humorizeWithPreview: humorizeMock };
});

const runAssistantMock = vi.fn(async () => ({
  kind: 'text' as const,
  text: 'Готово.',
  humorizable: true,
}));
vi.mock('../src/llm/assistant.js', () => ({ runAssistant: runAssistantMock }));

const sent: string[] = [];

async function load() {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  delete process.env.OPENAI_API_KEY; // the slang pass stays out of the way
  vi.resetModules();
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
  return import('../src/bot/flows/assist.js');
}

function ctx(chatId: number): Context {
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
      sendRichMessage: async (_id: number, p: { markdown: string }) => {
        sent.push(p.markdown);
        return {};
      },
      sendMessage: async (_id: number, t: string) => {
        sent.push(t);
        return {};
      },
    },
  } as unknown as Context;
}

async function reply(assist: Awaited<ReturnType<typeof load>>, chatId: number) {
  await assist.runAndRespond(ctx(chatId), {
    userContent: 'привет',
    addressed: true,
    source: 'text',
    historyText: 'привет',
  });
}

beforeEach(() => {
  humorizeMock.mockClear();
  runAssistantMock.mockClear();
  sent.length = 0;
});
afterEach(async () => {
  const { closeDb } = await import('../src/db/client.js');
  closeDb();
});

describe('humour gating by chat mode', () => {
  it('never humorizes a reply in assistant mode', async () => {
    const assist = await load();
    const settings = await import('../src/db/repos/chatSettings.repo.js');
    settings.setChatMode(-1, 'assistant');

    await reply(assist, -1);

    expect(humorizeMock).not.toHaveBeenCalled();
    expect(sent[0]).toBe('Готово.');
  });

  it('still humorizes a secretary chat (the gate is the mode, not the feature)', async () => {
    const assist = await load();
    const settings = await import('../src/db/repos/chatSettings.repo.js');
    settings.setChatMode(-2, 'secretary');

    await reply(assist, -2);

    expect(humorizeMock).toHaveBeenCalledOnce();
    expect(sent[0]).toBe('😂 Готово.');
  });
});

describe('expense quip gating by chat mode', () => {
  it('skips the joke next to an expense preview in assistant mode', async () => {
    const assist = await load();
    void assist;
    const settings = await import('../src/db/repos/chatSettings.repo.js');
    const { prepareQuip } = await import('../src/bot/flows/preview.js');
    const { takeQuip } = await import('../src/bot/quipCache.js');
    settings.setChatMode(-3, 'assistant');

    prepareQuip('pending-1', 'Такси 500', -3);
    await new Promise((r) => setTimeout(r, 10));
    expect(takeQuip('pending-1')).toBeUndefined();
  });
});
