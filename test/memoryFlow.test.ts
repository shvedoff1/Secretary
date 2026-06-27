import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Control the LLM extraction; everything else (buffer, persistence, trigger,
// subject resolution, pruning) runs for real against an in-memory DB.
const extractMock = vi.fn();
vi.mock('../src/llm/memory.js', () => ({
  extractMemory: extractMock,
}));

let closeDb: () => void;

async function load() {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  process.env.MEMORY_BATCH_SIZE = '2';
  vi.resetModules();
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
  const flow = await import('../src/bot/flows/memory.js');
  const repo = await import('../src/db/repos/memoryItem.repo.js');
  ({ closeDb } = await import('../src/db/client.js'));
  return { flow, repo };
}

beforeEach(() => {
  extractMock.mockReset();
});
afterEach(() => {
  if (closeDb) closeDb();
  delete process.env.MEMORY_BATCH_SIZE;
  delete process.env.ENABLE_MEMORY;
});

describe('learnMemoryFromMessage', () => {
  it('buffers without extracting until the batch size is reached, then persists', async () => {
    const { flow, repo } = await load();
    extractMock.mockResolvedValue({
      newItems: [{ scope: 'user', subject: 'Sky', content: 'любит кофе', importance: 3 }],
      reinforcedIds: [],
    });

    await flow.learnMemoryFromMessage(1, 100, 'Sky', 'первое сообщение');
    expect(extractMock).not.toHaveBeenCalled();
    expect(repo.sampleStats(1).count).toBe(1);

    // Second message hits batchSize=2 → extracts, persists, clears the buffer.
    await flow.learnMemoryFromMessage(1, 100, 'Sky', 'второе сообщение про кофе');
    expect(extractMock).toHaveBeenCalledOnce();
    expect(repo.sampleStats(1).count).toBe(0);

    const items = repo.getAllItems(1);
    expect(items).toHaveLength(1);
    // The subject "Sky" resolves to the sender's tg id from the claimed batch.
    expect(items[0]).toMatchObject({
      scope: 'user',
      tgUserId: 100,
      content: 'любит кофе',
      source: 'passive',
    });
  });

  it('passes the buffered samples (with senders) to the extractor', async () => {
    const { flow } = await load();
    extractMock.mockResolvedValue({ newItems: [], reinforcedIds: [] });
    await flow.learnMemoryFromMessage(1, 100, 'Sky', 'a');
    await flow.learnMemoryFromMessage(1, 200, 'Max', 'b');
    const samples = extractMock.mock.calls[0]![0];
    expect(samples).toEqual([
      { tgUserId: 100, senderName: 'Sky', content: 'a' },
      { tgUserId: 200, senderName: 'Max', content: 'b' },
    ]);
  });

  it('reinforces an existing fact by id instead of duplicating', async () => {
    const { flow, repo } = await load();
    const id = repo.insertPinned(1, 'едет на Бали');
    const before = repo.getAllItems(1)[0]!;
    extractMock.mockResolvedValue({ newItems: [], reinforcedIds: [id] });

    await flow.learnMemoryFromMessage(1, 100, 'Sky', 'опять про Бали');
    await flow.learnMemoryFromMessage(1, 100, 'Sky', 'снова Бали');

    const after = repo.getAllItems(1);
    expect(after).toHaveLength(1); // no duplicate row
    expect(after[0]!.reinforce).toBe(1);
    expect(after[0]!.lastSeen).toBeGreaterThanOrEqual(before.lastSeen);
  });

  it('ignores blank messages', async () => {
    const { flow, repo } = await load();
    await flow.learnMemoryFromMessage(1, 100, 'Sky', '   ');
    expect(repo.sampleStats(1).count).toBe(0);
  });

  it('does nothing when disabled', async () => {
    process.env.ENABLE_MEMORY = 'false';
    const { flow, repo } = await load();
    await flow.learnMemoryFromMessage(1, 100, 'Sky', 'a');
    await flow.learnMemoryFromMessage(1, 100, 'Sky', 'b');
    expect(extractMock).not.toHaveBeenCalled();
    expect(repo.sampleStats(1).count).toBe(0);
  });

  it('never throws even if extraction blows up', async () => {
    const { flow } = await load();
    extractMock.mockRejectedValue(new Error('boom'));
    await flow.learnMemoryFromMessage(1, 100, 'Sky', 'a');
    await expect(flow.learnMemoryFromMessage(1, 100, 'Sky', 'b')).resolves.toBeUndefined();
  });
});

describe('flushStaleMemories', () => {
  it('extracts for chats whose buffer aged past the max', async () => {
    const { flow, repo } = await load();
    extractMock.mockResolvedValue({
      newItems: [{ scope: 'chat', subject: '', content: 'общий факт', importance: 2 }],
      reinforcedIds: [],
    });
    // One sample, under batchSize, so only the age path can flush it.
    repo.recordSample(7, 100, 'Sky', 'одинокое сообщение');

    const db = (await import('../src/db/client.js')).getDb();
    db.prepare('UPDATE chat_memory_sample SET created_at = ? WHERE chat_id = 7').run(1);

    await flow.flushStaleMemories();
    expect(extractMock).toHaveBeenCalledOnce();
    expect(repo.getAllItems(7)[0]).toMatchObject({ scope: 'chat', content: 'общий факт' });
    expect(repo.sampleStats(7).count).toBe(0);
  });
});
