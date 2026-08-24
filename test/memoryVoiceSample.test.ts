import { describe, it, expect, vi, beforeEach } from 'vitest';

// A voice note reaches the extractor as a MACHINE TRANSCRIPT. The sender name comes
// from Telegram and is solid, but every name inside the text was guessed by the
// transcriber — and a mis-heard one used as a fact's subject invents a person who
// does not exist. These pin the two halves that stop it: the batch line says which
// channel it came from, and the system prompt says what to do about it.

const BASE_ENV: Record<string, string> = {
  BOT_TOKEN: 'x',
  ANTHROPIC_API_KEY: 'x',
  ADMIN_TELEGRAM_ID: '1',
};

const createMock = vi.fn(async () => ({
  content: [{ type: 'text', text: '{"newItems":[],"reinforcedIds":[]}' }],
  usage: { input_tokens: 1, output_tokens: 1 },
}));

vi.mock('../src/llm/client.js', () => ({
  getAnthropic: () => ({ messages: { create: createMock } }),
}));

function lastCall() {
  return createMock.mock.calls[createMock.mock.calls.length - 1]![0] as unknown as {
    system: string;
    messages: { role: string; content: string }[];
  };
}

beforeEach(() => {
  for (const [k, v] of Object.entries(BASE_ENV)) process.env[k] = v;
  vi.resetModules();
  createMock.mockClear();
});

describe('extractMemory batch rendering', () => {
  it('labels a voice sample as a machine transcript and leaves text alone', async () => {
    const { extractMemory, VOICE_SAMPLE_LABEL } = await import('../src/llm/memory.js');
    await extractMemory(
      [
        { tgUserId: 1, senderName: 'Андрей Шведов', content: 'платил Швец', source: 'voice' },
        { tgUserId: 2, senderName: 'Иван', content: 'ок', source: 'text' },
      ],
      [],
    );

    const batch = lastCall().messages[0]!.content;
    expect(batch).toContain(`Андрей Шведов ${VOICE_SAMPLE_LABEL}: платил Швец`);
    // A typed message keeps the bare "Name: text" shape it always had.
    expect(batch).toContain('\nИван: ок');
    expect(batch).not.toContain('Иван [голосовое');
  });

  it('tells the extractor not to invent a person from a transcribed name', async () => {
    const { extractMemory, VOICE_SAMPLE_LABEL } = await import('../src/llm/memory.js');
    await extractMemory(
      [{ tgUserId: 1, senderName: 'Андрей', content: 'платил Швец', source: 'voice' }],
      [],
    );

    const system = lastCall().system;
    expect(system).toContain('NAMES FROM A TRANSCRIPT ARE UNRELIABLE');
    expect(system).toMatch(/Never introduce a NEW person/);
    // The marker the prompt names must be the one the renderer actually writes.
    expect(system).toContain(VOICE_SAMPLE_LABEL);
  });
});
