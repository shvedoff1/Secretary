import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Control the LLM extraction; everything else (buffer, persistence, trigger) runs
// for real against an in-memory DB.
const extractMock = vi.fn();
vi.mock('../src/llm/lexicon.js', () => ({
  extractLexicon: extractMock,
}));

let closeDb: () => void;

async function load() {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  process.env.LEXICON_BATCH_SIZE = '2';
  vi.resetModules();
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
  const flow = await import('../src/bot/flows/lexicon.js');
  const repo = await import('../src/db/repos/lexicon.repo.js');
  ({ closeDb } = await import('../src/db/client.js'));
  return { flow, repo };
}

beforeEach(() => {
  extractMock.mockReset();
});
afterEach(() => {
  if (closeDb) closeDb();
  delete process.env.LEXICON_BATCH_SIZE;
});

describe('learnFromMessage', () => {
  it('buffers without extracting until the batch size is reached', async () => {
    const { flow, repo } = await load();
    extractMock.mockResolvedValue([{ term: 'тип', gloss: 'типа' }]);

    await flow.learnFromMessage(1, 'первое');
    expect(extractMock).not.toHaveBeenCalled();
    expect(repo.sampleStats(1).count).toBe(1);

    // Second message hits batchSize=2 → extracts, persists, clears the buffer.
    await flow.learnFromMessage(1, 'второе тип');
    expect(extractMock).toHaveBeenCalledOnce();
    expect(extractMock).toHaveBeenCalledWith(['первое', 'второе тип']);
    expect(repo.sampleStats(1).count).toBe(0);
    expect(repo.getLexicon(1)[0]).toMatchObject({ term: 'тип', gloss: 'типа' });
  });

  it('ignores blank messages', async () => {
    const { flow, repo } = await load();
    await flow.learnFromMessage(1, '   ');
    expect(repo.sampleStats(1).count).toBe(0);
  });

  it('does nothing when disabled', async () => {
    process.env.ENABLE_LEXICON = 'false';
    const { flow, repo } = await load();
    await flow.learnFromMessage(1, 'тип');
    await flow.learnFromMessage(1, 'братик');
    expect(extractMock).not.toHaveBeenCalled();
    expect(repo.sampleStats(1).count).toBe(0);
    delete process.env.ENABLE_LEXICON;
  });

  it('never throws even if extraction blows up', async () => {
    const { flow } = await load();
    extractMock.mockRejectedValue(new Error('boom'));
    await flow.learnFromMessage(1, 'a');
    await expect(flow.learnFromMessage(1, 'b')).resolves.toBeUndefined();
  });
});

describe('flushStaleLexicons', () => {
  it('extracts for chats whose buffer aged past the max', async () => {
    const { flow, repo } = await load();
    extractMock.mockResolvedValue([{ term: 'кек', gloss: 'смешно' }]);
    // One sample, well under batchSize, so only the age path can flush it.
    repo.recordSample(7, 'одинокое сообщение');

    // Default LEXICON_MAX_AGE_HOURS=24; force the sample to look old.
    const db = (await import('../src/db/client.js')).getDb();
    db.prepare('UPDATE chat_lexicon_sample SET created_at = ? WHERE chat_id = 7').run(1);

    await flow.flushStaleLexicons();
    expect(extractMock).toHaveBeenCalledWith(['одинокое сообщение']);
    expect(repo.getLexicon(7)[0]).toMatchObject({ term: 'кек' });
    expect(repo.sampleStats(7).count).toBe(0);
  });
});
