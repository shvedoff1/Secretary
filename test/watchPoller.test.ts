import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Bot } from 'grammy';

// End-to-end poller behaviour over a real (in-memory) DB, with the two external
// edges mocked: the page fetch and the Haiku verdict. This is where the firing
// discipline lives — notify exactly once, keyword-gate the LLM, survive fetch
// failures, expire quietly-but-audibly.

let pageHtml: string | (() => string) = '';
const fetchMock = vi.fn(async () => (typeof pageHtml === 'function' ? pageHtml() : pageHtml));
vi.mock('../src/watch/fetch.js', () => ({
  fetchPageHtml: (...args: unknown[]) => fetchMock(...(args as [])),
}));

let verdict: { met: boolean; evidence: string } = { met: false, evidence: '' };
const checkMock = vi.fn(async () => verdict);
vi.mock('../src/llm/watchCheck.js', () => ({
  checkWatchCondition: (...args: unknown[]) => checkMock(...(args as [])),
}));

const sendMessage = vi.fn(async () => ({}));
const bot = { api: { sendMessage } } as unknown as Bot;

async function freshModules() {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  vi.resetModules();
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
  const poller = await import('../src/watch/poller.js');
  const repo = await import('../src/db/repos/pageWatch.repo.js');
  return { poller, repo };
}

let closeDb: () => void;
beforeEach(async () => {
  ({ closeDb } = await import('../src/db/client.js'));
  // mockReset (not mockClear): mockRejectedValue set in one test must not leak
  // into the next — reset restores the original vi.fn implementation.
  fetchMock.mockReset();
  checkMock.mockReset();
  sendMessage.mockReset();
  pageHtml = '';
  verdict = { met: false, evidence: '' };
});
afterEach(() => {
  if (closeDb) closeDb();
});

function armWatch(
  repo: Awaited<ReturnType<typeof freshModules>>['repo'],
  over: Record<string, unknown> = {},
): number {
  return repo.createWatch({
    chatId: 100,
    tgUserId: 1,
    title: 'Сеансы Титана',
    url: 'https://kinomax.ru/titan/2026-08-06',
    condition: 'появились сеансы фильма «Титан»',
    keywords: ['титан'],
    intervalMinutes: 15,
    expiresAt: Date.now() + 86_400_000,
    nextCheckAt: 0,
    ...over,
  });
}

describe('runDueWatches', () => {
  it('skips the LLM entirely while no keyword is on the page', async () => {
    const { poller, repo } = await freshModules();
    armWatch(repo);
    pageHtml = '<p>Сеансы: Дракон 19:00</p>';

    await poller.runDueWatches(bot);

    expect(checkMock).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    const [w] = repo.listWatches(100);
    expect(w!.nextCheckAt).toBeGreaterThan(Date.now()); // rescheduled
    expect(w!.lastHash).toBeNull();
  });

  it('asks the model once the keyword appears, and keeps watching on met=false', async () => {
    const { poller, repo } = await freshModules();
    armWatch(repo);
    pageHtml = '<p>Скоро в кино: Титан</p>';
    verdict = { met: false, evidence: '' };

    await poller.runDueWatches(bot);

    expect(checkMock).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
    const [w] = repo.listWatches(100);
    expect(w!.enabled).toBe(true);
    expect(w!.lastHash).not.toBeNull();
  });

  it('does not re-ask the model while the page content is unchanged', async () => {
    const { poller, repo } = await freshModules();
    const id = armWatch(repo);
    pageHtml = '<p>Скоро в кино: Титан</p>';

    await poller.runDueWatches(bot);
    expect(checkMock).toHaveBeenCalledTimes(1);

    repo.forceCheck(id, 100); // make it due again with the same page
    await poller.runDueWatches(bot);
    expect(checkMock).toHaveBeenCalledTimes(1); // hash matched — no second call
  });

  it('notifies the chat once and disarms the watch when the event is met', async () => {
    const { poller, repo } = await freshModules();
    armWatch(repo);
    pageHtml = '<p>Титан: сеансы 19:30, 21:00</p>';
    verdict = { met: true, evidence: 'сеансы 19:30 и 21:00' };

    await poller.runDueWatches(bot);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text] = sendMessage.mock.calls[0] as unknown as [number, string];
    expect(chatId).toBe(100);
    expect(text).toContain('Сеансы Титана');
    expect(text).toContain('сеансы 19:30 и 21:00');
    expect(text).toContain('https://kinomax.ru/titan/2026-08-06');
    expect(repo.listWatches(100)).toEqual([]); // disarmed

    await poller.runDueWatches(bot); // nothing due anymore
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('keeps the watch armed if the met-notification fails to send (retries next poll)', async () => {
    const { poller, repo } = await freshModules();
    const id = armWatch(repo);
    pageHtml = '<p>Титан: сеансы 19:30</p>';
    verdict = { met: true, evidence: 'сеансы 19:30' };
    sendMessage.mockRejectedValueOnce(new Error('telegram down'));

    await poller.runDueWatches(bot);
    expect(repo.listWatches(100).length).toBe(1); // still armed

    repo.forceCheck(id, 100);
    await poller.runDueWatches(bot);
    expect(repo.listWatches(100)).toEqual([]); // delivered on the retry
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('counts consecutive fetch failures and warns the chat exactly once', async () => {
    const { poller, repo } = await freshModules();
    const id = armWatch(repo);
    fetchMock.mockRejectedValue(new Error('HTTP 403'));

    for (let i = 0; i < 12; i++) {
      repo.forceCheck(id, 100);
      await poller.runDueWatches(bot);
    }

    expect(repo.listWatches(100)[0]!.failCount).toBe(12);
    const warnings = sendMessage.mock.calls.filter(([, text]) =>
      String(text).includes('не могу открыть'),
    );
    expect(warnings.length).toBe(1); // announced at the threshold, then silent
  });

  it('a successful fetch resets the failure streak', async () => {
    const { poller, repo } = await freshModules();
    const id = armWatch(repo);
    fetchMock.mockRejectedValueOnce(new Error('boom'));
    await poller.runDueWatches(bot);
    expect(repo.listWatches(100)[0]!.failCount).toBe(1);

    pageHtml = '<p>ничего</p>';
    repo.forceCheck(id, 100);
    await poller.runDueWatches(bot);
    expect(repo.listWatches(100)[0]!.failCount).toBe(0);
  });

  it('disarms an expired watch with a farewell note instead of polling it', async () => {
    const { poller, repo } = await freshModules();
    armWatch(repo, { expiresAt: Date.now() - 1 });

    await poller.runDueWatches(bot);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(repo.listWatches(100)).toEqual([]);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(String(sendMessage.mock.calls[0]![1])).toContain('время вышло');
  });

  it('does nothing when ENABLE_WATCH is off', async () => {
    process.env.ENABLE_WATCH = 'false';
    try {
      const { poller, repo } = await freshModules();
      armWatch(repo);
      pageHtml = '<p>Титан: сеансы 19:30</p>';
      verdict = { met: true, evidence: 'сеансы' };

      await poller.runDueWatches(bot);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalled();
    } finally {
      delete process.env.ENABLE_WATCH;
    }
  });
});
