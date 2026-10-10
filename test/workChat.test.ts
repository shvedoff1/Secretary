import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import type { Context } from 'grammy';

// The «бот сидит в рабочем чате с тредами» setup over a real in-memory DB:
// migration 035, thread/kind filters on the log, topic names, the summarize_chat
// thread scope + focus, view_media, and the /listen switch.

const condenseMock = vi.fn(async (chunks: string[], _focus?: string | null) => ({
  notes: chunks.map((_, i) => `конспект ${i}`),
  failed: 0,
}));
vi.mock('../src/llm/summarize.js', () => ({
  condenseChunks: (chunks: string[], focus?: string | null) => condenseMock(chunks, focus),
}));

const downloadMock = vi.fn<(api: unknown, fileId: string) => Promise<Buffer>>();
vi.mock('../src/util/telegramFile.js', () => ({
  downloadTelegramFile: vi.fn(),
  downloadTelegramFileVia: (api: unknown, fileId: string) => downloadMock(api, fileId),
}));

function seedEnv() {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
}

async function fresh() {
  seedEnv();
  vi.resetModules();
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
  return {
    log: await import('../src/db/repos/chatLog.repo.js'),
    topics: await import('../src/db/repos/topic.repo.js'),
  };
}

let closeDb: () => void;
beforeEach(async () => {
  condenseMock.mockClear();
  downloadMock.mockReset();
  ({ closeDb } = await import('../src/db/client.js'));
});
afterEach(() => {
  if (closeDb) closeDb();
  delete process.env.SUMMARY_CHAR_BUDGET;
  delete process.env.SUMMARY_TAIL_CHAR_BUDGET;
});

const CHAT = -1001234567890;
const TZ = 'UTC';
const ask = { limit: null, fromDate: null, toDate: null, timezone: TZ };

describe('migration 035', () => {
  it('keeps every existing log row and starts them with no thread/link/media', async () => {
    seedEnv();
    vi.resetModules();
    const { getDb } = await import('../src/db/client.js');
    const db = getDb();
    // Bring a base up to 034 by hand, write a pre-035 row, then let migrate() finish.
    const dir = new URL('../src/db/migrations/', import.meta.url);
    db.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)');
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      const v = Number(/^(\d+)/.exec(f)![1]);
      if (v > 34) continue;
      db.exec(readFileSync(new URL(f, dir), 'utf8'));
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(v);
    }
    db.prepare(
      `INSERT INTO chat_message_log (chat_id, tg_user_id, sender_name, role, kind, content, created_at)
       VALUES (5, 7, 'Гоша', 'user', 'voice', 'старое голосовое', 1000)`,
    ).run();

    const { migrate } = await import('../src/db/migrate.js');
    migrate();
    const { readLog, logMessage } = await import('../src/db/repos/chatLog.repo.js');
    expect(readLog(5, { limit: 10 })).toEqual([
      expect.objectContaining({
        kind: 'voice',
        content: 'старое голосовое',
        threadId: null,
        messageId: null,
        mediaFileId: null,
      }),
    ]);
    // The widened channel list takes videos now.
    logMessage({ chatId: 5, role: 'user', kind: 'video', tgUserId: 7, content: '(кружок, 0:12)' });
    expect(readLog(5, { limit: 10 }).map((m) => m.kind)).toEqual(['voice', 'video']);
  });
});

describe('chat log filters', () => {
  it('narrows by topic (0 = General) and by channel', async () => {
    const { log } = await fresh();
    const add = (content: string, kind: 'text' | 'voice', threadId: number | null, t: number) =>
      log.logMessage({ chatId: CHAT, role: 'user', kind, tgUserId: 7, content, threadId, createdAt: t });
    add('общий текст', 'text', null, 1);
    add('qa текст', 'text', 12, 2);
    add('qa голос', 'voice', 12, 3);
    add('релиз голос', 'voice', 40, 4);

    const contents = (f: Parameters<typeof log.readLog>[1]) =>
      log.readLog(CHAT, f).map((m) => m.content);
    expect(contents({ limit: 10, threadId: 12 })).toEqual(['qa текст', 'qa голос']);
    expect(contents({ limit: 10, threadId: 0 })).toEqual(['общий текст']);
    expect(contents({ limit: 10, kinds: ['voice'] })).toEqual(['qa голос', 'релиз голос']);
    expect(contents({ limit: 10, threadId: 12, kinds: ['voice'] })).toEqual(['qa голос']);
    expect(log.countLog(CHAT, { kinds: ['voice'] })).toBe(2);
  });

  it('getLogEntry is chat-scoped', async () => {
    const { log } = await fresh();
    log.logMessage({ chatId: CHAT, role: 'user', kind: 'photo', tgUserId: 7, content: 'скрин', mediaFileId: 'F1', messageId: 3 });
    const [row] = log.readLog(CHAT, { limit: 1 });
    expect(log.getLogEntry(CHAT, row!.id)).toMatchObject({ mediaFileId: 'F1', messageId: 3 });
    expect(log.getLogEntry(-100999, row!.id)).toBeNull();
  });
});

describe('topic repo', () => {
  it('stores, renames and lists topics per chat', async () => {
    const { topics } = await fresh();
    topics.upsertTopic(CHAT, 12, 'Баги');
    topics.upsertTopic(CHAT, 12, 'QA');
    topics.upsertTopic(CHAT, 40, 'Релиз');
    topics.upsertTopic(-100555, 12, 'чужой');
    topics.upsertTopic(CHAT, 0, 'General'); // General isn't a topic row
    expect(topics.listTopics(CHAT)).toEqual([
      { threadId: 12, name: 'QA' },
      { threadId: 40, name: 'Релиз' },
    ]);
    expect(topics.topicName(CHAT, 40)).toBe('Релиз');
  });

  it('learnTopicName picks names up from passing messages', async () => {
    const { topics } = await fresh();
    const { learnTopicName } = await import('../src/bot/threads.js');
    learnTopicName(CHAT, {
      message_id: 99,
      is_topic_message: true,
      message_thread_id: 7,
      reply_to_message: { forum_topic_created: { name: 'Дизайн', icon_color: 0 } },
    });
    expect(topics.topicName(CHAT, 7)).toBe('Дизайн');
  });
});

describe('summarize_chat in a forum chat', () => {
  async function seeded() {
    const env = await fresh();
    env.topics.upsertTopic(CHAT, 12, 'QA');
    env.topics.upsertTopic(CHAT, 40, 'Релиз');
    const now = Date.now();
    const add = (over: Record<string, unknown>) =>
      env.log.logMessage({ chatId: CHAT, role: 'user', tgUserId: 7, senderName: 'Петя', content: '', ...over } as Parameters<typeof env.log.logMessage>[0]);
    add({ content: 'кто на обед', threadId: null, messageId: 1, createdAt: now - 5000 });
    add({ content: 'после логина пустая корзина', kind: 'voice', threadId: 12, messageId: 2, createdAt: now - 4000 });
    add({ content: '(фото без подписи)', kind: 'photo', threadId: 12, messageId: 3, mediaFileId: 'PH', createdAt: now - 3000 });
    add({ content: 'релиз в пятницу', threadId: 40, messageId: 4, createdAt: now - 2000 });
    const { makeSummarizeChatHandler } = await import('../src/summary/handler.js');
    return { ...env, makeSummarizeChatHandler };
  }

  it('reads the whole chat with topic tags and links on voice/media lines', async () => {
    const { makeSummarizeChatHandler } = await seeded();
    const out = await makeSummarizeChatHandler(CHAT)(ask);
    expect(out).toContain('{General} Петя: кто на обед');
    expect(out).toContain('{QA} Петя (голосовое): после логина пустая корзина https://t.me/c/1234567890/12/2');
    expect(out).toMatch(/\{QA\} Петя \(фото\): \(фото без подписи\) \[медиа #\d+\] https:\/\/t\.me\/c\/1234567890\/12\/3/);
    // Plain text lines carry no link in a general recap.
    expect(out).not.toContain('t.me/c/1234567890/1\n');
  });

  it('scopes to one topic by name, or to «этот тред» from where the user asks', async () => {
    const { makeSummarizeChatHandler } = await seeded();
    const byName = await makeSummarizeChatHandler(CHAT)({ ...ask, thread: 'qa' });
    expect(byName).toContain('Scope: topic «QA»');
    expect(byName).toContain('после логина');
    expect(byName).not.toContain('релиз в пятницу');
    expect(byName).not.toContain('{QA}'); // one topic => no tags

    const here = await makeSummarizeChatHandler(CHAT, { currentThreadId: 40 })({ ...ask, thread: 'этот тред' });
    expect(here).toContain('релиз в пятницу');
    expect(here).not.toContain('корзина');
  });

  it('an unknown topic is reported with the known ones, not guessed', async () => {
    const { makeSummarizeChatHandler } = await seeded();
    const out = await makeSummarizeChatHandler(CHAT)({ ...ask, thread: 'маркетинг' });
    expect(out).toContain('No forum topic matches «маркетинг»');
    expect(out).toContain('«QA» (id 12)');
  });

  it('bug candidates from voice notes: voice only, links on every line, focused task', async () => {
    const { makeSummarizeChatHandler } = await seeded();
    const out = await makeSummarizeChatHandler(CHAT)({
      ...ask,
      kinds: ['voice'],
      focus: 'кандидаты в баги',
    });
    expect(out).toContain('only voice messages');
    expect(out).toContain('после логина пустая корзина https://t.me/c/1234567890/12/2');
    expect(out).not.toContain('кто на обед');
    expect(out).toContain('looking specifically for: «кандидаты в баги»');
    expect(out).not.toContain('Summarise this for the user');
  });

  it('says the SCOPE is empty rather than the window', async () => {
    const { makeSummarizeChatHandler } = await seeded();
    const out = await makeSummarizeChatHandler(CHAT)({ ...ask, thread: 'Релиз', kinds: ['voice'] });
    expect(out).toContain('match the scope');
  });

  it('hands the focus to the condense tier on a long window', async () => {
    process.env.SUMMARY_CHAR_BUDGET = '200';
    process.env.SUMMARY_TAIL_CHAR_BUDGET = '100';
    const { log, makeSummarizeChatHandler } = await seeded();
    for (let i = 0; i < 20; i++) {
      log.logMessage({ chatId: CHAT, role: 'user', kind: 'voice', tgUserId: 7, senderName: 'Петя', content: `голосовое номер ${i} про приложение`, threadId: 12, messageId: 100 + i });
    }
    const out = await makeSummarizeChatHandler(CHAT)({ ...ask, focus: 'кандидаты в баги' });
    expect(out).toContain('CONDENSED NOTES');
    expect(condenseMock).toHaveBeenCalledWith(expect.any(Array), 'кандидаты в баги');
    // The chunks the cheap model sees keep the links it must copy through.
    expect(condenseMock.mock.calls[0]![0].join('\n')).toContain('https://t.me/c/1234567890/12/');
  });
});

describe('view_media', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);

  it('sniffs image types from magic bytes', async () => {
    const { sniffImageType } = await import('../src/summary/media.js');
    expect(sniffImageType(PNG)).toBe('image/png');
    expect(sniffImageType(JPEG)).toBe('image/jpeg');
    expect(sniffImageType(Buffer.from('RIFF0000WEBPVP8 '))).toBe('image/webp');
    expect(sniffImageType(Buffer.from('%PDF-1.7'))).toBeNull();
  });

  it('opens one logged picture, chat-scoped, and says a video is only its still', async () => {
    const { log } = await fresh();
    log.logMessage({ chatId: CHAT, role: 'user', kind: 'photo', tgUserId: 7, senderName: 'Петя', content: 'скрин ошибки', mediaFileId: 'PH', messageId: 3, threadId: 12 });
    log.logMessage({ chatId: CHAT, role: 'user', kind: 'video', tgUserId: 7, senderName: 'Аня', content: '(видео, 0:40)', mediaFileId: 'TH', messageId: 4 });
    log.logMessage({ chatId: CHAT, role: 'user', kind: 'text', tgUserId: 7, content: 'просто текст' });
    const [photo, video, text] = log.readLog(CHAT, { limit: 10 });
    const { makeViewMediaHandler } = await import('../src/summary/media.js');
    const view = makeViewMediaHandler(CHAT, {} as never);

    downloadMock.mockResolvedValueOnce(PNG);
    const opened = await view({ ref: photo!.id });
    expect(downloadMock).toHaveBeenCalledWith(expect.anything(), 'PH');
    expect(Array.isArray(opened)).toBe(true);
    const blocks = opened as { type: string; text?: string; source?: { media_type: string } }[];
    expect(blocks[0]!.text).toContain('скрин ошибки');
    expect(blocks[0]!.text).toContain('https://t.me/c/1234567890/12/3');
    expect(blocks[1]).toMatchObject({ type: 'image', source: { media_type: 'image/png' } });

    downloadMock.mockResolvedValueOnce(JPEG);
    const still = (await view({ ref: video!.id })) as { text?: string }[];
    expect(still[0]!.text).toContain('ONLY the preview frame');

    expect(await view({ ref: text!.id })).toContain('nothing to open');
    expect(await makeViewMediaHandler(-100999, {} as never)({ ref: photo!.id })).toContain('No logged message');

    downloadMock.mockRejectedValueOnce(new Error('gone'));
    expect(await view({ ref: photo!.id })).toContain('Could not download');
  });
});

describe('/listen command', () => {
  function adminCtx(match: string) {
    const replies: string[] = [];
    const ctx = {
      from: { id: 1 },
      chat: { id: 1, type: 'private' },
      match,
      reply: async (t: string) => {
        replies.push(t);
        return {};
      },
    } as unknown as Context;
    return { ctx, replies };
  }

  it('toggles listen-only for a chat and shows it', async () => {
    await fresh();
    const { ensureAdmin } = await import('../src/db/repos/users.repo.js');
    ensureAdmin(1);
    const { cmdListen } = await import('../src/bot/commands/admin.js');
    const repo = await import('../src/db/repos/chatSettings.repo.js');
    expect(repo.isListenOnly(CHAT)).toBe(false);

    const on = adminCtx(`${CHAT} on`);
    await cmdListen(on.ctx);
    expect(repo.isListenOnly(CHAT)).toBe(true);
    expect(on.replies[0]).toContain('ТОЛЬКО на @упоминание');

    const status = adminCtx(`${CHAT}`);
    await cmdListen(status.ctx);
    expect(status.replies[0]).toContain('тихий режим ВКЛ');

    await cmdListen(adminCtx(`${CHAT} off`).ctx);
    expect(repo.isListenOnly(CHAT)).toBe(false);

    const bad = adminCtx(`${CHAT} maybe`);
    await cmdListen(bad.ctx);
    expect(bad.replies[0]).toContain('Использование');
  });
});

describe('random reactions in a listen-only chat', () => {
  it('drops none where /listen is on', async () => {
    await fresh();
    const { setListenOnly } = await import('../src/db/repos/chatSettings.repo.js');
    const { maybeAutoReact } = await import('../src/bot/reactions.js');
    const react = vi.fn(async () => {});
    const c = { chat: { id: CHAT, type: 'supergroup' }, message: { text: 'ок' }, react } as unknown as Context;
    const roll = vi.spyOn(Math, 'random').mockReturnValue(0); // the roll would pass

    setListenOnly(CHAT, true);
    await maybeAutoReact(c);
    expect(react).not.toHaveBeenCalled();

    setListenOnly(CHAT, false);
    await maybeAutoReact(c);
    expect(react).toHaveBeenCalledOnce();
    roll.mockRestore();
  });
});
