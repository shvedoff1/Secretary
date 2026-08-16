import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildTools, RECALL_MEMORY_TOOL } from '../src/llm/tools.js';
import { RecallMemoryZ } from '../src/llm/schema.js';

// The deep memory tier: a big store that costs no tokens until the model reaches
// into it with `recall_memory`.

async function freshChat() {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  process.env.ENABLE_MEMORY = 'true';
  vi.resetModules();
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
  return {
    repo: await import('../src/db/repos/memoryItem.repo.js'),
    recall: (await import('../src/bot/flows/assist.js')).makeRecallMemoryHandler(1),
  };
}

let closeDb: () => void;
beforeEach(async () => {
  ({ closeDb } = await import('../src/db/client.js'));
});
afterEach(() => {
  if (closeDb) closeDb();
  delete process.env.ENABLE_MEMORY;
});

describe('recall_memory tool wiring', () => {
  it('is exposed by default and can be switched off with memory', () => {
    const names = (tools: ReturnType<typeof buildTools>) =>
      tools.filter((t) => 'name' in t).map((t) => (t as { name: string }).name);
    expect(names(buildTools({ enableWebSearch: false, enableExpense: false }))).toContain(
      RECALL_MEMORY_TOOL,
    );
    expect(
      names(buildTools({ enableWebSearch: false, enableExpense: false, enableRecall: false })),
    ).not.toContain(RECALL_MEMORY_TOOL);
  });

  it('accepts the nullable shape the model actually sends', () => {
    expect(RecallMemoryZ.safeParse({ query: 'аллергия', about: null }).success).toBe(true);
    expect(RecallMemoryZ.safeParse({ query: null, about: 'Гоша' }).success).toBe(true);
    expect(RecallMemoryZ.safeParse({ query: 'x' }).success).toBe(false);
  });
});

describe('recall_memory handler', () => {
  it('finds a fact that the injected working set would never have carried', async () => {
    const { repo, recall } = await freshChat();
    // 60 rotating facts — far past MEMORY_CONTEXT_CHAT (8), so this one is only
    // reachable by searching.
    repo.recordMemoryItems(
      1,
      Array.from({ length: 60 }, (_, i) => ({
        scope: 'chat' as const,
        tgUserId: null,
        subject: '',
        content: `болтовня номер ${i}`,
        importance: 3,
      })),
    );
    repo.recordMemoryItems(1, [
      {
        scope: 'chat',
        tgUserId: null,
        subject: '',
        content: 'Пароль от вайфая в доме — surfhouse2024',
        importance: 2,
      },
    ]);

    const out = recall({ query: 'пароль вайфай', about: null });
    expect(out).toContain('surfhouse2024');
  });

  it('answers "what do you know about X" from `about` alone', async () => {
    const { repo, recall } = await freshChat();
    repo.recordMemoryItems(1, [
      { scope: 'user', tgUserId: 42, subject: 'Гоша', content: 'аллергия на орехи', importance: 4 },
      { scope: 'user', tgUserId: 7, subject: 'Андрей', content: 'катает серфинг', importance: 4 },
    ]);

    const out = recall({ query: null, about: 'Гоша' });
    expect(out).toContain('аллергия на орехи');
    expect(out).not.toContain('серфинг');
  });

  it('marks pinned and voice facts so the model can weigh them', async () => {
    const { repo, recall } = await freshChat();
    repo.insertPinned(1, 'Ключи от квартиры у соседа');
    const out = recall({ query: 'ключи квартира', about: null });
    expect(out).toContain('📌');
  });

  it('tells the model plainly when nothing matched, instead of nothing at all', async () => {
    const { repo, recall } = await freshChat();
    repo.recordMemoryItems(1, [
      { scope: 'chat', tgUserId: null, subject: '', content: 'играли в доту', importance: 3 },
    ]);
    const out = recall({ query: 'пароль от сейфа', about: null });
    expect(out).toContain('Ничего не нашёл');
    expect(out).toContain('не выдумывай');
  });

  it('refuses an empty query rather than dumping the store', async () => {
    const { recall } = await freshChat();
    expect(recall({ query: null, about: null })).toContain('Пустой запрос');
  });

  it('caps how much one search returns (it lands in the context as tokens)', async () => {
    process.env.MEMORY_RECALL_LIMIT = '3';
    try {
      const { repo, recall } = await freshChat();
      repo.recordMemoryItems(
        1,
        Array.from({ length: 20 }, (_, i) => ({
          scope: 'chat' as const,
          tgUserId: null,
          subject: '',
          content: `аллергия у человека номер ${i}`,
          importance: 3,
        })),
      );
      const out = recall({ query: 'аллергия', about: null });
      expect(out.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(3);
    } finally {
      delete process.env.MEMORY_RECALL_LIMIT;
    }
  });
});

describe('memoryStats', () => {
  it('counts the store by tier, so the context can say how much is hidden', async () => {
    const { repo } = await freshChat();
    repo.recordMemoryItems(1, [
      { scope: 'chat', tgUserId: null, subject: '', content: 'едут на Бали', importance: 3 },
    ]);
    repo.insertPinned(1, 'Ключи у соседа');
    const persona = repo.insertPinned(1, 'Шути про серфинг');
    repo.setItemScope(1, persona, 'persona');

    expect(repo.memoryStats(1)).toEqual({ total: 3, pinned: 1, persona: 1 });
    expect(repo.memoryStats(999)).toEqual({ total: 0, pinned: 0, persona: 0 });
  });
});

describe('memory listing with a deep store', () => {
  it('shows a bounded slice and says how many are hidden', async () => {
    // Regression: raising MEMORY_MAX_ITEMS made a full dump dozens of Telegram
    // messages — and /memory sends ONE reply, which would exceed the 4096 cap.
    process.env.MEMORY_DISPLAY_LIMIT = '5';
    try {
      const { repo } = await freshChat();
      repo.recordMemoryItems(
        1,
        Array.from({ length: 30 }, (_, i) => ({
          scope: 'chat' as const,
          tgUserId: null,
          subject: '',
          content: `факт номер ${i}`,
          importance: 3,
        })),
      );

      const { cmdMemory } = await import('../src/bot/commands/memory.js');
      const sent: string[] = [];
      await cmdMemory({
        chat: { id: 1 },
        reply: async (text: string) => {
          sent.push(text);
        },
      } as never);

      const text = sent.join('\n');
      expect(text).toContain('30 записей');
      expect(text).toContain('…и ещё 25 записей');
      expect(text.split('\n').filter((l) => /^\d+\. /.test(l))).toHaveLength(5);
    } finally {
      delete process.env.MEMORY_DISPLAY_LIMIT;
    }
  });
});
