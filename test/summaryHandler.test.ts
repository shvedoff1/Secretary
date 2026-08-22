import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The summarize_chat handler over a real (in-memory) log. Fresh DB + module reset
// per test so the config (ENABLE_CHAT_LOG and the size bounds) is re-read.
async function fresh(env: Record<string, string> = {}) {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  vi.resetModules();
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
  return {
    repo: await import('../src/db/repos/chatLog.repo.js'),
    handler: (await import('../src/summary/handler.js')).makeSummarizeChatHandler(1),
  };
}

const TOUCHED = ['ENABLE_CHAT_LOG', 'SUMMARY_DEFAULT_MESSAGES', 'SUMMARY_MAX_MESSAGES', 'SUMMARY_CHAR_BUDGET'];

let closeDb: () => void;
beforeEach(async () => {
  ({ closeDb } = await import('../src/db/client.js'));
});
afterEach(() => {
  if (closeDb) closeDb();
  for (const key of TOUCHED) delete process.env[key];
});

const TZ = 'Europe/Moscow';
const ask = { limit: null, fromDate: null, toDate: null, timezone: TZ };
const DAY = 24 * 60 * 60 * 1000;

describe('summarize_chat handler', () => {
  it('returns the transcript of the recent window with a window note', async () => {
    const { repo, handler } = await fresh();
    const now = Date.now();
    repo.logMessage({ chatId: 1, role: 'user', tgUserId: 7, senderName: 'Гоша', content: 'кто идёт на серф', createdAt: now - 2000 });
    repo.logMessage({ chatId: 1, role: 'user', kind: 'voice', tgUserId: 8, senderName: 'Ира', content: 'я иду', createdAt: now - 1000 });
    repo.logMessage({ chatId: 1, role: 'assistant', tgUserId: null, content: 'волны метр', createdAt: now });

    const out = handler(ask);
    expect(out).toContain('CHAT TRANSCRIPT');
    expect(out).toContain('Гоша: кто идёт на серф');
    expect(out).toContain('Ира (голосовое): я иду');
    expect(out).toContain('Бот: волны метр');
    expect(out).toContain('Rendered 3 message(s) of 3');
    // Another chat's log must never leak into this one.
    expect(out).not.toContain('чужое');
  });

  it('reads only the requested count, and says more is available', async () => {
    const { repo, handler } = await fresh();
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      repo.logMessage({ chatId: 1, role: 'user', tgUserId: 7, senderName: 'Гоша', content: `реплика ${i}`, createdAt: now - (10 - i) * 1000 });
    }
    const out = handler({ ...ask, limit: 3 });
    expect(out).toContain('реплика 9');
    expect(out).toContain('реплика 7');
    expect(out).not.toContain('реплика 6');
    expect(out).toContain('Rendered 3 message(s) of 10');
    expect(out).toContain('older message(s) beyond the requested count');
  });

  it('resolves a date window in the chat timezone', async () => {
    const { repo, handler } = await fresh();
    const now = Date.now();
    repo.logMessage({ chatId: 1, role: 'user', tgUserId: 7, senderName: 'Гоша', content: 'вчерашнее', createdAt: now - DAY });
    repo.logMessage({ chatId: 1, role: 'user', tgUserId: 7, senderName: 'Гоша', content: 'сегодняшнее', createdAt: now });

    const { zonedParts, previousDateStr } = await import('../src/util/day.js');
    const yesterday = previousDateStr(zonedParts(now, TZ).dateStr);
    const out = handler({ ...ask, fromDate: yesterday, toDate: yesterday });
    expect(out).toContain('вчерашнее');
    expect(out).not.toContain('сегодняшнее');
  });

  it('says the log is EMPTY when nothing has ever been recorded', async () => {
    const { handler } = await fresh();
    expect(handler(ask)).toContain('EMPTY');
  });

  it('distinguishes an empty PERIOD from an empty log', async () => {
    const { repo, handler } = await fresh();
    repo.logMessage({ chatId: 1, role: 'user', tgUserId: 7, senderName: 'Гоша', content: 'было дело', createdAt: Date.now() });
    const out = handler({ ...ask, fromDate: '2020-01-01', toDate: '2020-01-01' });
    expect(out).toContain('No messages in the requested window');
    expect(out).toContain('1 января');
    expect(out).not.toContain('EMPTY');
  });

  it('admits when the oldest part of the window did not fit the budget', async () => {
    const { repo, handler } = await fresh({ SUMMARY_CHAR_BUDGET: '120' });
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      repo.logMessage({ chatId: 1, role: 'user', tgUserId: 7, senderName: 'Гоша', content: `реплика ${i}`, createdAt: now - (10 - i) * 1000 });
    }
    const out = handler(ask);
    expect(out).toContain('did not fit the size budget');
    expect(out).toContain('реплика 9');
  });

  it('clamps a huge ask to the configured ceiling', async () => {
    const { repo, handler } = await fresh({ SUMMARY_MAX_MESSAGES: '5' });
    const now = Date.now();
    for (let i = 0; i < 20; i++) {
      repo.logMessage({ chatId: 1, role: 'user', tgUserId: 7, senderName: 'Гоша', content: `реплика ${i}`, createdAt: now - (20 - i) * 1000 });
    }
    const out = handler({ ...ask, limit: 2000 });
    expect(out).toContain('Rendered 5 message(s) of 20');
  });

  it('says logging is off rather than pretending the chat was silent', async () => {
    const { repo, handler } = await fresh({ ENABLE_CHAT_LOG: 'false' });
    repo.logMessage({ chatId: 1, role: 'user', tgUserId: 7, senderName: 'Гоша', content: 'было дело' });
    expect(handler(ask)).toContain('disabled');
  });
});
