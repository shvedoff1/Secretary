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

// Forwarded pictures are downloaded at drain time — stub the Telegram file API.
const downloadMock = vi.fn(async (_ctx: unknown, fileId: string) =>
  Buffer.from(`bytes:${fileId}`),
);
vi.mock('../src/util/telegramFile.js', () => ({
  downloadTelegramFile: (ctx: unknown, fileId: string) => downloadMock(ctx, fileId),
}));

async function load(env: Record<string, string> = {}) {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  delete process.env.OPENAI_API_KEY;
  delete process.env.FORWARD_BUFFER_MAX_PHOTOS;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
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
  downloadMock.mockClear();
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

describe('forwarded pictures in the batch', () => {
  type Block =
    | { type: 'text'; text: string }
    | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };
  function assistantBlocks(): Block[] {
    return (runAssistantMock.mock.calls[0]![0] as unknown as { userContent: Block[] }).userContent;
  }
  const photo = (messageId: number, text = '') => ({
    messageId,
    origin: 'Петя',
    kind: 'photo' as const,
    text,
    image: { fileId: `file-${messageId}`, mediaType: 'image/jpeg' as const },
  });

  it('downloads the parked photo at drain time and attaches it as a real image', async () => {
    const { assist, fb } = await load();
    fb.bufferForward(-777, photo(70, 'вот это место'));

    await assist.runAndRespond(ctx(), {
      userContent: 'что на картинке и стоит ли туда ехать?',
      addressed: true,
      source: 'text',
      historyText: 'что на картинке и стоит ли туда ехать?',
      includeForwardBatch: true,
    });

    const blocks = assistantBlocks();
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks[0]!.type).toBe('text');
    const head = (blocks[0] as { text: string }).text;
    expect(head).toContain('Пересланная пачка — 1 сообщений');
    expect(head).toContain('[картинка приложена ниже: изображение 1]');
    const image = blocks[1] as Extract<Block, { type: 'image' }>;
    expect(image.type).toBe('image');
    expect(image.source.media_type).toBe('image/jpeg');
    expect(image.source.data).toBe(Buffer.from('bytes:file-70').toString('base64'));
    // The user's own ask still closes the turn.
    expect((blocks.at(-1) as { text: string }).text).toBe('что на картинке и стоит ли туда ехать?');
    expect(downloadMock).toHaveBeenCalledTimes(1);
    fb.resetForwardBuffers();
  });

  it('degrades a failed download to caption-only and says so instead of guessing', async () => {
    const { assist, fb } = await load();
    fb.bufferForward(-777, photo(70, 'вот это место'));
    downloadMock.mockRejectedValueOnce(new Error('telegram down'));

    await assist.runAndRespond(ctx(), {
      userContent: 'что на картинке?',
      addressed: true,
      source: 'text',
      historyText: 'что на картинке?',
      includeForwardBatch: true,
    });

    // No image made it — the turn stays a plain string, and the block admits it.
    const content = assistantCall().userContent;
    expect(typeof content).toBe('string');
    expect(content).toContain('[картинку скачать не удалось — есть только подпись]');
    fb.resetForwardBuffers();
  });

  it('caps the attached pictures and marks the tail as skipped', async () => {
    const { assist, fb } = await load({ FORWARD_BUFFER_MAX_PHOTOS: '1' });
    fb.bufferForward(-777, photo(70));
    fb.bufferForward(-777, photo(71));

    await assist.runAndRespond(ctx(), {
      userContent: 'о чём картинки?',
      addressed: true,
      source: 'text',
      historyText: 'о чём картинки?',
      includeForwardBatch: true,
    });

    const blocks = assistantBlocks();
    const head = (blocks[0] as { text: string }).text;
    expect(head).toContain('1. (Петя, фото) (фото без подписи) [картинка приложена ниже: изображение 1]');
    expect(head).toContain('2. (Петя, фото) (фото без подписи) [картинка не приложена — лимит картинок на пачку]');
    expect(blocks.filter((b) => b.type === 'image')).toHaveLength(1);
    expect(downloadMock).toHaveBeenCalledTimes(1);
    fb.resetForwardBuffers();
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
