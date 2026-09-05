import { describe, it, expect, vi, beforeEach } from 'vitest';

// The expense-intent classifier: the second source of `memoryFree` for addressed
// turns the regex gate didn't catch. It must (1) see only the message, roster and
// recent turns — never memory — (2) be bounded (timeout, no retries), and (3) fail
// OPEN: anything but a clean verdict is 'unknown', which keeps memory on.

let responses: unknown[] = [];
const createMock = vi.fn(async (..._args: unknown[]) => {
  const next = responses.shift();
  if (next instanceof Error) throw next;
  return next;
});

vi.mock('../src/llm/client.js', () => ({
  getAnthropic: () => ({ messages: { create: createMock } }),
}));

function textResponse(text: string) {
  return { content: [{ type: 'text', text }] };
}

beforeEach(() => {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  vi.resetModules();
  createMock.mockClear();
  responses = [];
});

const args = {
  text: '[голос] скинь Ване за ужин',
  senderName: 'Андрей Шведов',
  source: 'voice',
  members: ['Андрей Шведов', 'Иван'],
  recent: ['Иван: вчера был ужин у моря', 'бот: 🤙'],
};

describe('parseExpenseVerdict', () => {
  it('reads a boolean verdict and treats everything else as unknown', async () => {
    const { parseExpenseVerdict } = await import('../src/llm/expenseClassify.js');
    expect(parseExpenseVerdict('{"expense": true}')).toBe('expense');
    expect(parseExpenseVerdict('Sure: {"expense":false}')).toBe('other');
    expect(parseExpenseVerdict('{"expense": "yes"}')).toBe('unknown');
    expect(parseExpenseVerdict('{"met": true}')).toBe('unknown');
    expect(parseExpenseVerdict('not json')).toBe('unknown');
    expect(parseExpenseVerdict('')).toBe('unknown');
  });
});

describe('classifyExpenseIntent', () => {
  it('returns the verdict and sends only message, roster and recent turns', async () => {
    responses = [textResponse('{"expense": true}')];
    const { classifyExpenseIntent } = await import('../src/llm/expenseClassify.js');
    expect(await classifyExpenseIntent(args)).toBe('expense');

    const [body, opts] = createMock.mock.calls[0] as unknown as [
      { temperature: number; messages: { content: string }[]; system: string },
      { timeout: number; maxRetries: number },
    ];
    expect(body.temperature).toBe(0);
    const input = body.messages[0]!.content;
    expect(input).toContain('скинь Ване за ужин');
    expect(input).toContain('Group members: Андрей Шведов, Иван');
    expect(input).toContain('Иван: вчера был ужин у моря');
    expect(input).toContain('channel: voice');
    // No memory-shaped section can be there: the input is built from these
    // fields alone.
    expect(input).not.toContain('Chat memory');
    expect(input).not.toContain('journal');
    // Bounded: a slow verdict is dropped rather than retried.
    expect(opts.timeout).toBe(3_000);
    expect(opts.maxRetries).toBe(0);
  });

  it('answers other for a non-expense verdict', async () => {
    responses = [textResponse('{"expense": false}')];
    const { classifyExpenseIntent } = await import('../src/llm/expenseClassify.js');
    expect(await classifyExpenseIntent(args)).toBe('other');
  });

  it('fails open: an API error or garbage output is unknown, never a throw', async () => {
    responses = [new Error('timeout')];
    const { classifyExpenseIntent } = await import('../src/llm/expenseClassify.js');
    expect(await classifyExpenseIntent(args)).toBe('unknown');

    responses = [textResponse('я думаю это трата')];
    expect(await classifyExpenseIntent(args)).toBe('unknown');
  });

  it('honours the timeout knob', async () => {
    process.env.EXPENSE_CLASSIFY_TIMEOUT_MS = '1500';
    responses = [textResponse('{"expense": false}')];
    const { classifyExpenseIntent } = await import('../src/llm/expenseClassify.js');
    await classifyExpenseIntent(args);
    const opts = createMock.mock.calls[0]![1] as { timeout: number };
    expect(opts.timeout).toBe(1500);
    delete process.env.EXPENSE_CLASSIFY_TIMEOUT_MS;
  });
});
