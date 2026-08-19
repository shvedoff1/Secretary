import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Context } from 'grammy';

// An UNADDRESSED message that merely looks like a spend is an expense-only scan:
// the assistant can record an expense or produce nothing at all (its text is
// discarded). Memory has no job there, and it actively misfires — a remembered
// «я — Швед» made the model take the payer from memory instead of from the sender
// («Швед купил круассан», sent by Андрей Шведов). These tests pin the three halves
// of the fix: the flow skips memory, runAssistant cuts the toolset, and the context
// block renders none of the conversation-only sections.

const runAssistantMock = vi.fn(async () => ({
  kind: 'text' as const,
  text: 'ничего',
  humorizable: true,
}));

vi.mock('../src/llm/assistant.js', () => ({ runAssistant: runAssistantMock }));

async function load() {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  delete process.env.OPENAI_API_KEY; // keeps the tone passes out of the way
  vi.resetModules();
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
  return {
    assist: await import('../src/bot/flows/assist.js'),
    memory: await import('../src/db/repos/memoryItem.repo.js'),
  };
}

const sent: string[] = [];

function ctx(chatId = -555): Context {
  return {
    chat: { id: chatId, type: 'group', title: 'Чат' },
    from: { id: 7, first_name: 'Андрей', last_name: 'Шведов' },
    message: { message_id: 3 },
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
    expenseOnly?: boolean;
    memoryChat?: { content: string }[];
    memoryUsers?: { subject: string; items: { content: string }[] }[];
    memoryPersona?: { content: string }[];
    memoryTotal?: number;
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

describe('runAndRespond: memory on the silent auto-expense scan', () => {
  it('sends no memory and flags the run expense-only when not addressed', async () => {
    const { assist, memory } = await load();
    memory.insertPinned(-555, 'Швед — это я', {
      scope: 'user',
      subject: 'Андрей Шведов',
      tgUserId: 7,
    });
    memory.insertPinned(-555, 'едем на Бали в марте');

    await assist.runAndRespond(ctx(), {
      userContent: 'круассан 50 Ивану',
      addressed: false,
      source: 'text',
      historyText: 'круассан 50 Ивану',
    });

    const call = assistantCall();
    expect(call.expenseOnly).toBe(true);
    expect(call.memoryChat).toEqual([]);
    expect(call.memoryUsers).toEqual([]);
    expect(call.memoryPersona).toEqual([]);
    expect(call.memoryTotal).toBe(0);
  });

  it('still sends memory for an addressed message in the same chat', async () => {
    const { assist, memory } = await load();
    memory.insertPinned(-555, 'едем на Бали в марте');

    await assist.runAndRespond(ctx(), {
      userContent: 'Скай, куда мы едем?',
      addressed: true,
      source: 'text',
      historyText: 'Скай, куда мы едем?',
    });

    const call = assistantCall();
    expect(call.expenseOnly).toBe(false);
    expect(call.memoryChat).toEqual([{ content: 'едем на Бали в марте' }]);
    expect(call.memoryTotal).toBe(1);
  });
});
