import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The cheap compression tier is mocked here — this file is about WHICH tier runs and
// what the handler tells the model about it; the pass itself is covered separately.
const condenseMock = vi.fn(async (chunks: string[]) => ({
  notes: chunks.map((_, i) => `конспект блока ${i}`),
  failed: 0,
}));
vi.mock('../src/llm/summarize.js', () => ({
  condenseChunks: (chunks: string[]) => condenseMock(chunks),
}));

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

const TOUCHED = [
  'ENABLE_CHAT_LOG',
  'SUMMARY_DEFAULT_MESSAGES',
  'SUMMARY_MAX_MESSAGES',
  'SUMMARY_CHAR_BUDGET',
  'ENABLE_SUMMARY_CONDENSE',
  'SUMMARY_TAIL_CHAR_BUDGET',
  'SUMMARY_CONDENSE_CHUNK_CHARS',
  'SUMMARY_CONDENSE_MAX_CHUNKS',
];

let closeDb: () => void;
beforeEach(async () => {
  condenseMock.mockClear();
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

    const out = await handler(ask);
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
    const out = await handler({ ...ask, limit: 3 });
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
    const out = await handler({ ...ask, fromDate: yesterday, toDate: yesterday });
    expect(out).toContain('вчерашнее');
    expect(out).not.toContain('сегодняшнее');
  });

  it('says the log is EMPTY when nothing has ever been recorded', async () => {
    const { handler } = await fresh();
    expect(await handler(ask)).toContain('EMPTY');
  });

  it('distinguishes an empty PERIOD from an empty log', async () => {
    const { repo, handler } = await fresh();
    repo.logMessage({ chatId: 1, role: 'user', tgUserId: 7, senderName: 'Гоша', content: 'было дело', createdAt: Date.now() });
    const out = await handler({ ...ask, fromDate: '2020-01-01', toDate: '2020-01-01' });
    expect(out).toContain('No messages in the requested window');
    expect(out).toContain('1 января');
    expect(out).not.toContain('EMPTY');
  });

  it('admits the cut when the window is too big and compression is off', async () => {
    const { repo, handler } = await fresh({
      SUMMARY_CHAR_BUDGET: '120',
      ENABLE_SUMMARY_CONDENSE: 'false',
    });
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      repo.logMessage({ chatId: 1, role: 'user', tgUserId: 7, senderName: 'Гоша', content: `реплика ${i}`, createdAt: now - (10 - i) * 1000 });
    }
    const out = await handler(ask);
    expect(out).toContain('did not fit the size budget');
    expect(out).toContain('реплика 9');
  });

  it('clamps a huge ask to the configured ceiling', async () => {
    const { repo, handler } = await fresh({ SUMMARY_MAX_MESSAGES: '5' });
    const now = Date.now();
    for (let i = 0; i < 20; i++) {
      repo.logMessage({ chatId: 1, role: 'user', tgUserId: 7, senderName: 'Гоша', content: `реплика ${i}`, createdAt: now - (20 - i) * 1000 });
    }
    const out = await handler({ ...ask, limit: 2000 });
    expect(out).toContain('Rendered 5 message(s) of 20');
  });

  it('says logging is off rather than pretending the chat was silent', async () => {
    const { repo, handler } = await fresh({ ENABLE_CHAT_LOG: 'false' });
    repo.logMessage({ chatId: 1, role: 'user', tgUserId: 7, senderName: 'Гоша', content: 'было дело' });
    expect(await handler(ask)).toContain('disabled');
  });
});

describe('summarize_chat two-tier compression', () => {
  // A 500-message window is several times the verbatim budget; instead of showing
  // only its tail, the older part is compressed by the cheap model.
  async function bigWindow(env: Record<string, string> = {}) {
    const ctx = await fresh({
      SUMMARY_CHAR_BUDGET: '600',
      SUMMARY_TAIL_CHAR_BUDGET: '200',
      SUMMARY_CONDENSE_CHUNK_CHARS: '400',
      SUMMARY_CONDENSE_MAX_CHUNKS: '20',
      SUMMARY_MAX_MESSAGES: '1000',
      ...env,
    });
    const now = Date.now();
    for (let i = 0; i < 200; i++) {
      ctx.repo.logMessage({
        chatId: 1,
        role: 'user',
        tgUserId: 7,
        senderName: 'Гоша',
        content: `реплика номер ${i}`,
        createdAt: now - (200 - i) * 1000,
      });
    }
    return ctx;
  }

  it('condenses the old part, keeps the newest verbatim, and says which is which', async () => {
    const { handler } = await bigWindow();
    const out = await handler(ask);

    expect(condenseMock).toHaveBeenCalledOnce();
    const chunks = condenseMock.mock.calls[0]![0];
    expect(chunks.length).toBeGreaterThan(1);
    // Chunks are oldest-first and none of them contains the verbatim tail.
    expect(chunks[0]).toContain('реплика номер 0');
    expect(chunks.join('\n')).not.toContain('реплика номер 199');

    expect(out).toContain('=== CONDENSED NOTES');
    expect(out).toContain('конспект блока 0');
    expect(out).toContain('=== VERBATIM');
    expect(out).toContain('реплика номер 199');
    expect(out).toContain('appear as CONDENSED NOTES');
  });

  it('covers the whole window, not just the tail', async () => {
    const { handler } = await bigWindow();
    const out = await handler(ask);
    // 200 logged, none dropped: everything is either condensed or verbatim.
    expect(out).toContain('200 message(s) of 200 logged');
    expect(out).not.toContain('left out completely');
  });

  it('reports the oldest blocks it had to leave out entirely', async () => {
    const { handler } = await bigWindow({ SUMMARY_CONDENSE_MAX_CHUNKS: '1' });
    const out = await handler(ask);
    expect(out).toContain('left out completely');
    expect(condenseMock.mock.calls[0]![0]).toHaveLength(1);
  });

  it('flags a partial compression failure as a gap', async () => {
    condenseMock.mockImplementationOnce(async (chunks: string[]) => ({
      notes: chunks.slice(1).map((_, i) => `конспект ${i}`),
      failed: 1,
    }));
    const { handler } = await bigWindow();
    expect(await handler(ask)).toContain('could not be compressed');
  });

  it('falls back to the truncated window when compression fails completely', async () => {
    condenseMock.mockImplementationOnce(async () => ({ notes: [], failed: 3 }));
    const { handler } = await bigWindow();
    const out = await handler(ask);
    expect(out).toContain('FAILED');
    expect(out).not.toContain('=== CONDENSED NOTES');
    // Still useful: the recent part is there, and the model is told to say so.
    expect(out).toContain('реплика номер 199');
  });

  it('does not call the cheap model when the window fits verbatim', async () => {
    const { repo, handler } = await fresh();
    repo.logMessage({ chatId: 1, role: 'user', tgUserId: 7, senderName: 'Гоша', content: 'коротко' });
    const out = await handler(ask);
    expect(condenseMock).not.toHaveBeenCalled();
    expect(out).toContain('коротко');
  });
});
