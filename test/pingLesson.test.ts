import { describe, it, expect, vi, beforeEach } from 'vitest';

const BASE_ENV: Record<string, string> = {
  BOT_TOKEN: 'x',
  ANTHROPIC_API_KEY: 'x',
  ADMIN_TELEGRAM_ID: '1',
};

let response: unknown;
const createMock = vi.fn(async () => response);

vi.mock('../src/llm/client.js', () => ({
  getAnthropic: () => ({ messages: { create: createMock } }),
}));

function textResponse(text: string) {
  return {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text }],
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

async function load() {
  for (const [k, v] of Object.entries(BASE_ENV)) process.env[k] = v;
  vi.resetModules();
  return import('../src/llm/pingLesson.js');
}

describe('generatePingLesson', () => {
  beforeEach(() => {
    createMock.mockClear();
    createMock.mockImplementation(async () => response);
  });

  it('returns the trimmed generated lesson and feeds the recent chat into the prompt', async () => {
    response = textResponse('  Урок: кто спрашивает «когда катка» — тот уже морально на руне.  ');
    const { generatePingLesson } = await load();
    const out = await generatePingLesson([
      { name: 'Вася', text: 'ну что, когда катка?' },
      { name: 'Петя', text: 'я после пар' },
    ]);

    expect(out).toBe('Урок: кто спрашивает «когда катка» — тот уже морально на руне.');
    const call = createMock.mock.calls[0]![0] as {
      messages: { content: string }[];
      system: { text: string }[];
      thinking: { type: string };
    };
    // The chat's last messages reach the model as context…
    expect(call.messages[0]!.content).toContain('Вася: ну что, когда катка?');
    expect(call.messages[0]!.content).toContain('Петя: я после пар');
    // …and stays snappy (no adaptive thinking on Sonnet 5).
    expect(call.thinking).toEqual({ type: 'disabled' });
  });

  it('puts the canned lessons into the system prompt as tone references', async () => {
    response = textResponse('Урок.');
    const mod = await load();
    await mod.generatePingLesson([]);

    const call = createMock.mock.calls[0]![0] as { system: { text: string }[] };
    const system = call.system[0]!.text;
    expect(system).toContain('Dota 2');
    expect(system).toContain('референсы');
    // A couple of the canned lessons must be present verbatim as examples.
    expect(system).toContain(mod.PING_LESSONS[0]!);
    expect(system).toContain(mod.PING_LESSONS[mod.PING_LESSONS.length - 1]!);
    // The beefed-up format: a 3-4 sentence lesson with zoomer slang and emoji.
    expect(system).toContain('3-4 предложения');
    expect(system).toContain('Эмодзи');
    expect(system).toContain('скилл ишью');
  });

  it('tells the model the chat is quiet when there is no recent chatter', async () => {
    response = textResponse('Урок.');
    const mod = await load();
    await mod.generatePingLesson([]);

    const call = createMock.mock.calls[0]![0] as { messages: { content: string }[] };
    expect(call.messages[0]!.content).toContain('тихо');
  });

  it('defangs any stray @mention in the output so a lesson can never ping', async () => {
    response = textResponse('Урок: @vasya стоит на руне уже минуту.');
    const mod = await load();
    const out = await mod.generatePingLesson([]);
    expect(out).toContain(`@​vasya`);
    expect(out).not.toMatch(/@vasya/);
  });

  it('returns null on an API error (caller falls back to the canned pool)', async () => {
    createMock.mockRejectedValue(new Error('529'));
    const mod = await load();
    await expect(mod.generatePingLesson([])).resolves.toBeNull();
  });

  it('returns null on empty model output', async () => {
    response = textResponse('   ');
    const mod = await load();
    await expect(mod.generatePingLesson([])).resolves.toBeNull();
  });
});
