import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Fresh in-memory DB per test; repo imported after env + module reset so it binds
// to the freshly-opened database.
async function fresh() {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  vi.resetModules();
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
  return await import('../src/db/repos/chatLog.repo.js');
}

let closeDb: () => void;
beforeEach(async () => {
  ({ closeDb } = await import('../src/db/client.js'));
});
afterEach(() => {
  if (closeDb) closeDb();
});

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

describe('chat log repo', () => {
  it('reads back messages oldest-first with author and channel', async () => {
    const repo = await fresh();
    repo.logMessage({
      chatId: 1,
      role: 'user',
      tgUserId: 7,
      senderName: 'Гоша',
      content: 'погнали на серф',
      createdAt: 1000,
    });
    repo.logMessage({
      chatId: 1,
      role: 'user',
      kind: 'voice',
      tgUserId: 8,
      senderName: 'Ира',
      content: 'я за',
      createdAt: 2000,
    });
    repo.logMessage({
      chatId: 1,
      role: 'assistant',
      tgUserId: null,
      content: 'волны метр, го',
      createdAt: 3000,
    });

    const rows = repo.readLog(1, { limit: 10 });
    expect(rows.map((r) => [r.role, r.kind, r.senderName, r.content])).toEqual([
      ['user', 'text', 'Гоша', 'погнали на серф'],
      ['user', 'voice', 'Ира', 'я за'],
      ['assistant', 'text', null, 'волны метр, го'],
    ]);
  });

  it('keeps other chats out of the window', async () => {
    const repo = await fresh();
    repo.logMessage({ chatId: 1, role: 'user', tgUserId: 7, content: 'наше' });
    repo.logMessage({ chatId: 2, role: 'user', tgUserId: 7, content: 'чужое' });
    expect(repo.readLog(1, { limit: 10 }).map((r) => r.content)).toEqual(['наше']);
    expect(repo.countLog(1)).toBe(1);
  });

  it('limit takes the NEWEST messages, still returned chronologically', async () => {
    const repo = await fresh();
    for (let i = 1; i <= 5; i++) {
      repo.logMessage({ chatId: 1, role: 'user', tgUserId: 7, content: `msg ${i}`, createdAt: i * 1000 });
    }
    expect(repo.readLog(1, { limit: 2 }).map((r) => r.content)).toEqual(['msg 4', 'msg 5']);
  });

  it('filters by a time window', async () => {
    const repo = await fresh();
    const now = Date.now();
    repo.logMessage({ chatId: 1, role: 'user', tgUserId: 7, content: 'позавчера', createdAt: now - 2 * DAY });
    repo.logMessage({ chatId: 1, role: 'user', tgUserId: 7, content: 'вчера', createdAt: now - DAY });
    repo.logMessage({ chatId: 1, role: 'user', tgUserId: 7, content: 'сегодня', createdAt: now });

    const rows = repo.readLog(1, { limit: 100, fromMs: now - DAY - MIN, toMs: now - DAY + MIN });
    expect(rows.map((r) => r.content)).toEqual(['вчера']);
    expect(repo.countLog(1, { fromMs: now - DAY - MIN, toMs: now - DAY + MIN })).toBe(1);
  });

  it('skips blank content instead of logging empty lines', async () => {
    const repo = await fresh();
    repo.logMessage({ chatId: 1, role: 'user', tgUserId: 7, content: '   \n ' });
    expect(repo.countLog(1)).toBe(0);
  });

  it('prunes by count and by age, and leaves other chats alone', async () => {
    const repo = await fresh();
    const now = Date.now();
    for (let i = 1; i <= 10; i++) {
      repo.logMessage({ chatId: 1, role: 'user', tgUserId: 7, content: `msg ${i}`, createdAt: now - (11 - i) * MIN });
    }
    repo.logMessage({ chatId: 1, role: 'user', tgUserId: 7, content: 'древнее', createdAt: now - 40 * DAY });
    repo.logMessage({ chatId: 2, role: 'user', tgUserId: 7, content: 'чужое', createdAt: now - 40 * DAY });

    repo.pruneLog(1, 3, 30 * DAY);

    expect(repo.readLog(1, { limit: 100 }).map((r) => r.content)).toEqual([
      'msg 8',
      'msg 9',
      'msg 10',
    ]);
    expect(repo.countLog(2)).toBe(1);
  });

  it('reports the oldest kept timestamp and clears a chat', async () => {
    const repo = await fresh();
    repo.logMessage({ chatId: 1, role: 'user', tgUserId: 7, content: 'a', createdAt: 5000 });
    repo.logMessage({ chatId: 1, role: 'user', tgUserId: 7, content: 'b', createdAt: 9000 });
    expect(repo.oldestLoggedAt(1)).toBe(5000);
    repo.clearLog(1);
    expect(repo.countLog(1)).toBe(0);
    expect(repo.oldestLoggedAt(1)).toBeNull();
  });
});
