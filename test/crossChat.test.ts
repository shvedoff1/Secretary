import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// «Что там в рабочем чате?» asked from the DM: chat resolution, the membership
// gate, and the summarize_chat / view_media handlers reading another chat.

vi.mock('../src/llm/summarize.js', () => ({
  condenseChunks: async (chunks: string[]) => ({ notes: chunks.map(() => 'конспект'), failed: 0 }),
}));
const downloadMock = vi.fn<(api: unknown, fileId: string) => Promise<Buffer>>();
vi.mock('../src/util/telegramFile.js', () => ({
  downloadTelegramFile: vi.fn(),
  downloadTelegramFileVia: (api: unknown, fileId: string) => downloadMock(api, fileId),
}));

async function fresh() {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  vi.resetModules();
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
  return {
    log: await import('../src/db/repos/chatLog.repo.js'),
    settings: await import('../src/db/repos/chatSettings.repo.js'),
    access: await import('../src/summary/access.js'),
  };
}

let closeDb: () => void;
beforeEach(async () => {
  downloadMock.mockReset();
  ({ closeDb } = await import('../src/db/client.js'));
});
afterEach(() => {
  if (closeDb) closeDb();
});

const ME = 555; // the asker; their DM chat id is the same number
const DEV = -1001111111111;
const SECRET = -1002222222222;
const ask = { limit: null, fromDate: null, toDate: null, timezone: 'UTC' };

async function seeded() {
  const env = await fresh();
  env.settings.setChatTitle(DEV, 'Dev команда');
  env.settings.setChatTitle(SECRET, 'Совет директоров');
  env.log.logMessage({ chatId: DEV, role: 'user', kind: 'voice', tgUserId: ME, senderName: 'Я', content: 'после логина пустая корзина', messageId: 10 });
  env.log.logMessage({ chatId: DEV, role: 'user', kind: 'photo', tgUserId: 7, senderName: 'Петя', content: 'скрин', messageId: 11, mediaFileId: 'PH' });
  env.log.logMessage({ chatId: SECRET, role: 'user', tgUserId: 9, senderName: 'Босс', content: 'увольняем всех', messageId: 5 });
  env.log.logMessage({ chatId: ME, role: 'user', tgUserId: ME, content: 'личное' });
  return env;
}

/** A fake getChatMember: ME is in DEV only. */
function fakeApi(calls: number[] = []) {
  return {
    getChatMember: vi.fn(async (chatId: number, userId: number) => {
      calls.push(chatId);
      if (chatId === DEV && userId === ME) return { status: 'member' };
      if (chatId === SECRET) return { status: 'left' };
      throw new Error('chat not found');
    }),
  };
}

describe('membership gate', () => {
  it('counts members, admins, owners and restricted-but-present users', async () => {
    const { access } = await fresh();
    expect(access.isMemberStatus({ status: 'member' })).toBe(true);
    expect(access.isMemberStatus({ status: 'administrator' })).toBe(true);
    expect(access.isMemberStatus({ status: 'creator' })).toBe(true);
    expect(access.isMemberStatus({ status: 'restricted', is_member: true })).toBe(true);
    expect(access.isMemberStatus({ status: 'restricted', is_member: false })).toBe(false);
    expect(access.isMemberStatus({ status: 'left' })).toBe(false);
    expect(access.isMemberStatus({ status: 'kicked' })).toBe(false);
  });

  it('asks Telegram once per chat (cached), and denies on an API error', async () => {
    const { access } = await fresh();
    access.resetChatReadCache();
    const calls: number[] = [];
    const check = access.makeChatReadCheck(fakeApi(calls) as never, ME);
    expect(await check(DEV)).toBe(true);
    expect(await check(DEV)).toBe(true);
    expect(await check(SECRET)).toBe(false);
    expect(await check(-100999)).toBe(false);
    expect(await check(ME)).toBe(true); // own DM, no call
    expect(calls).toEqual([DEV, SECRET, -100999]);
  });
});

describe('chat lists', () => {
  it('lists logged groups, and the ones this person posted in, newest first', async () => {
    const { log, access } = await seeded();
    expect(log.listLoggedChats().map((c) => c.chatId).sort()).toEqual([SECRET, DEV].sort());
    expect(log.loggedChatsOfUser(ME)).toEqual([{ chatId: DEV, title: 'Dev команда' }]);
    expect(access.otherChatsLine(log.loggedChatsOfUser(ME))).toContain('«Dev команда» (id -1001111111111)');
    expect(access.otherChatsLine([])).toBeNull();
  });
});

describe('resolveChatRef', () => {
  it('matches titles forgivingly, ids exactly, and never guesses', async () => {
    const { resolveChatRef } = await import('../src/summary/transcript.js');
    const chats = [
      { chatId: DEV, title: 'Dev команда' },
      { chatId: -1003, title: 'Dev бэкенд' },
      { chatId: SECRET, title: 'Совет директоров' },
    ];
    expect(resolveChatRef('совет', chats)).toMatchObject({ ok: true, chatId: SECRET });
    expect(resolveChatRef('чат «Dev команда»', chats)).toMatchObject({ ok: true, chatId: DEV });
    expect(resolveChatRef(String(DEV), chats)).toMatchObject({ ok: true, chatId: DEV });
    expect(resolveChatRef('dev', chats)).toMatchObject({ ok: false });
    expect(resolveChatRef('маркетинг', chats)).toMatchObject({ ok: false });
  });
});

describe('summarize_chat from the DM', () => {
  async function dmHandler() {
    const env = await seeded();
    env.access.resetChatReadCache();
    const { makeSummarizeChatHandler } = await import('../src/summary/handler.js');
    const crossChat = { canRead: env.access.makeChatReadCheck(fakeApi() as never, ME) };
    return { ...env, handler: makeSummarizeChatHandler(ME, { crossChat }), makeSummarizeChatHandler };
  }

  it('reads a work chat the asker is a member of, with links back into it', async () => {
    const { handler } = await dmHandler();
    const out = await handler({ ...ask, chat: 'dev команда', focus: 'кандидаты в баги' });
    expect(out).toContain('Chat: «Dev команда»');
    expect(out).toContain('после логина пустая корзина https://t.me/c/1111111111/10');
    expect(out).not.toContain('личное');
  });

  it('refuses a chat the asker is NOT in — nothing of it leaks', async () => {
    const { handler } = await dmHandler();
    const out = await handler({ ...ask, chat: 'совет директоров' });
    expect(out).toContain('not a member');
    expect(out).not.toContain('увольняем');
  });

  it('refuses `chat` outside the DM (no crossChat), and an unknown name', async () => {
    const { handler, makeSummarizeChatHandler } = await dmHandler();
    const inGroup = await makeSummarizeChatHandler(DEV)({ ...ask, chat: 'совет директоров' });
    expect(inGroup).toContain('only possible from a private chat');
    expect(inGroup).not.toContain('увольняем');
    expect(await handler({ ...ask, chat: 'маркетинг' })).toContain('No logged chat matches');
  });

  it('without `chat` the DM still recaps itself', async () => {
    const { handler } = await dmHandler();
    const out = await handler(ask);
    expect(out).toContain('личное');
    expect(out).not.toContain('корзина');
  });
});

describe('view_media from the DM', () => {
  it('opens a picture from a chat the asker is in, never from one they are not', async () => {
    const env = await seeded();
    env.access.resetChatReadCache();
    env.log.logMessage({ chatId: SECRET, role: 'user', kind: 'photo', tgUserId: 9, content: 'план', mediaFileId: 'SECRET_PH', messageId: 6 });
    const devPhoto = env.log.readLog(DEV, { limit: 10 }).find((m) => m.mediaFileId)!;
    const secretPhoto = env.log.readLog(SECRET, { limit: 10 }).find((m) => m.mediaFileId)!;
    const { makeViewMediaHandler } = await import('../src/summary/media.js');
    const canRead = env.access.makeChatReadCheck(fakeApi() as never, ME);
    const view = makeViewMediaHandler(ME, {} as never, { canRead });

    downloadMock.mockResolvedValueOnce(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    const opened = (await view({ ref: devPhoto.id })) as { text?: string }[];
    expect(opened[0]!.text).toContain('https://t.me/c/1111111111/11');

    expect(await view({ ref: secretPhoto.id })).toContain('No logged message');
    expect(downloadMock).toHaveBeenCalledTimes(1);
    // Without a checker (a group), another chat's ref never opens.
    expect(await makeViewMediaHandler(ME, {} as never)({ ref: devPhoto.id })).toContain('No logged message');
  });
});
