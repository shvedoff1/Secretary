import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Context } from 'grammy';

// How the batch is CONSUMED: an addressed ask pulls the pack into its turn (and
// only entry points that opt in — a chime must never swallow it), and a tap on
// the 🫡 mark processes the pack with no typed request at all.

const runAssistantMock = vi.fn(async () => ({
  kind: 'text' as const,
  text: 'Саммари готово.',
  humorizable: true,
}));
vi.mock('../src/llm/assistant.js', () => ({ runAssistant: runAssistantMock }));

async function load() {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  delete process.env.OPENAI_API_KEY;
  vi.resetModules();
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
  return {
    assist: await import('../src/bot/flows/assist.js'),
    fb: await import('../src/bot/forwardBuffer.js'),
    reaction: await import('../src/bot/handlers/onForwardReaction.js'),
  };
}

const sent: string[] = [];
const reactionCalls: [number, number, unknown][] = [];

function ctx(chatId = -777, over: Record<string, unknown> = {}): Context {
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
      setMessageReaction: async (chat: number, msg: number, r: unknown) => {
        reactionCalls.push([chat, msg, r]);
        return true;
      },
    },
    ...over,
  } as unknown as Context;
}

function assistantCall() {
  return runAssistantMock.mock.calls[0]![0] as unknown as { userContent: string };
}

beforeEach(() => {
  runAssistantMock.mockClear();
  sent.length = 0;
  reactionCalls.length = 0;
});
afterEach(async () => {
  const { closeDb } = await import('../src/db/client.js');
  closeDb();
});

function seed(fb: Awaited<ReturnType<typeof load>>['fb'], chatId = -777) {
  fb.bufferForward(chatId, { messageId: 70, origin: 'Вася', kind: 'text', text: 'погнали в бар' });
  fb.bufferForward(chatId, {
    messageId: 71,
    origin: 'канал «X»',
    kind: 'voice',
    text: 'скидки только сегодня',
  });
}

describe('consuming the batch with an addressed ask', () => {
  it('prepends the rendered pack to the turn and clears the marks', async () => {
    const { assist, fb } = await load();
    seed(fb);

    await assist.runAndRespond(ctx(), {
      userContent: 'сделай саммари',
      addressed: true,
      source: 'text',
      historyText: 'сделай саммари',
      includeForwardBatch: true,
    });

    const content = assistantCall().userContent;
    expect(content).toContain('Пересланная пачка — 2 сообщений');
    expect(content).toContain('1. (Вася) погнали в бар');
    expect(content).toContain('2. (канал «X», голосовое — расшифровка) скидки только сегодня');
    expect(content.endsWith('сделай саммари')).toBe(true);
    // Consumed: the pack is gone and the 🫡 "buttons" were removed.
    expect(fb.bufferedCount(-777)).toBe(0);
    expect(reactionCalls.map(([, m]) => m).sort()).toEqual([70, 71]);
    // History carries a compact tag, not the whole pack.
    const conversation = await import('../src/db/repos/conversation.repo.js');
    expect(conversation.recentTurns(-777, 10, 60_000)[0]!.content).toBe(
      '[+пачка из 2 пересланных] сделай саммари',
    );
    fb.resetForwardBuffers();
  });

  it('does NOT consume the pack for a caller that did not opt in (chime, reword)', async () => {
    const { assist, fb } = await load();
    seed(fb);

    await assist.runAndRespond(ctx(), {
      userContent: 'ну чё, тихо тут у вас',
      addressed: true,
      source: 'text',
      historyText: 'ну чё, тихо тут у вас',
      // no includeForwardBatch — the chime path
    });

    expect(assistantCall().userContent).not.toContain('Пересланная пачка');
    expect(fb.bufferedCount(-777)).toBe(2); // still waiting for the real ask
    fb.resetForwardBuffers();
  });

  it('leaves a turn without a pending pack untouched', async () => {
    const { assist } = await load();
    await assist.runAndRespond(ctx(), {
      userContent: 'привет',
      addressed: true,
      source: 'text',
      historyText: 'привет',
      includeForwardBatch: true,
    });
    expect(assistantCall().userContent).toBe('привет');
  });
});

describe('the 🫡 reaction button', () => {
  function tapCtx(
    fbMark: string,
    over: { messageId?: number; oldHasMark?: boolean } = {},
  ): Context {
    const messageId = over.messageId ?? 70;
    return ctx(-777, {
      message: undefined,
      messageReaction: {
        message_id: messageId,
        old_reaction: over.oldHasMark ? [{ type: 'emoji', emoji: fbMark }] : [],
        new_reaction: [{ type: 'emoji', emoji: fbMark }],
      },
    });
  }

  it('processes the pack immediately on a tap, with a no-typed-request instruction', async () => {
    const { fb, reaction } = await load();
    seed(fb);

    await reaction.onForwardReaction(tapCtx(fb.FORWARD_MARK));

    expect(runAssistantMock).toHaveBeenCalledOnce();
    const content = assistantCall().userContent;
    expect(content).toContain('Пересланная пачка — 2 сообщений');
    expect(content).toContain('нажал на реакцию-кнопку');
    expect(fb.bufferedCount(-777)).toBe(0);
    expect(sent[0]).toBe('Саммари готово.');
    fb.resetForwardBuffers();
  });

  it('ignores a tap with a different emoji, a removal, and a non-buffered message', async () => {
    const { fb, reaction } = await load();
    seed(fb);

    await reaction.onForwardReaction(tapCtx('👍')); // wrong emoji
    await reaction.onForwardReaction(tapCtx(fb.FORWARD_MARK, { oldHasMark: true })); // removal/no-op
    await reaction.onForwardReaction(tapCtx(fb.FORWARD_MARK, { messageId: 999 })); // not in the pack

    expect(runAssistantMock).not.toHaveBeenCalled();
    expect(fb.bufferedCount(-777)).toBe(2);
    fb.resetForwardBuffers();
  });
});
