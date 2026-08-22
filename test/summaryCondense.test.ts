import { describe, it, expect, vi, beforeEach } from 'vitest';

// The cheap compression tier itself: one call per chunk, in parallel, and a failure
// that reports itself instead of silently shrinking the window.

const BASE_ENV: Record<string, string> = {
  BOT_TOKEN: 'x',
  ANTHROPIC_API_KEY: 'x',
  ADMIN_TELEGRAM_ID: '1',
};

const createMock = vi.fn();
vi.mock('../src/llm/client.js', () => ({
  getAnthropic: () => ({ messages: { create: createMock } }),
}));

function reply(text: string) {
  return { content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 1 } };
}

beforeEach(() => {
  for (const [k, v] of Object.entries(BASE_ENV)) process.env[k] = v;
  delete process.env.ANTHROPIC_SUMMARY_MODEL;
  vi.resetModules();
  createMock.mockReset();
});

describe('condenseChunk', () => {
  it('sends the chunk to the cheap model deterministically and returns the notes', async () => {
    process.env.ANTHROPIC_SUMMARY_MODEL = 'claude-haiku-4-5-20251001';
    createMock.mockResolvedValue(reply('  Гоша: едем в субботу  '));
    const { condenseChunk } = await import('../src/llm/summarize.js');

    expect(await condenseChunk('[10:00] Гоша: погнали в субботу')).toBe('Гоша: едем в субботу');
    const sent = createMock.mock.calls[0]![0];
    expect(sent).toMatchObject({ model: 'claude-haiku-4-5-20251001', temperature: 0 });
    expect(sent.messages[0].content).toContain('погнали в субботу');
  });

  it('returns null on an API failure or empty output instead of throwing', async () => {
    const { condenseChunk } = await import('../src/llm/summarize.js');
    createMock.mockRejectedValueOnce(new Error('boom'));
    expect(await condenseChunk('что-то')).toBeNull();
    createMock.mockResolvedValueOnce(reply('   '));
    expect(await condenseChunk('что-то')).toBeNull();
  });

  it('never calls the model for an empty chunk', async () => {
    const { condenseChunk } = await import('../src/llm/summarize.js');
    expect(await condenseChunk('  ')).toBeNull();
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe('condenseChunks', () => {
  it('compresses every chunk and keeps them in order', async () => {
    createMock
      .mockResolvedValueOnce(reply('первый'))
      .mockResolvedValueOnce(reply('второй'))
      .mockResolvedValueOnce(reply('третий'));
    const { condenseChunks } = await import('../src/llm/summarize.js');

    expect(await condenseChunks(['a', 'b', 'c'])).toEqual({
      notes: ['первый', 'второй', 'третий'],
      failed: 0,
    });
    expect(createMock).toHaveBeenCalledTimes(3);
  });

  it('counts the chunks that failed so the caller can admit the gap', async () => {
    createMock
      .mockResolvedValueOnce(reply('первый'))
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(reply('третий'));
    const { condenseChunks } = await import('../src/llm/summarize.js');

    expect(await condenseChunks(['a', 'b', 'c'])).toEqual({
      notes: ['первый', 'третий'],
      failed: 1,
    });
  });
});
