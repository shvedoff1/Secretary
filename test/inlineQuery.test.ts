import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Context } from 'grammy';

// Inline mode: the query handler must serve its card WITHOUT an LLM call (queries
// fire per keystroke), only to whitelisted users; the chosen-result handler runs
// the assistant with the asker's DM context — read-only — and edits the answer
// into the placeholder via inline_message_id. All asserted here against a mocked
// assistant (no LLM, no Telegram).

const runAssistantMock = vi.fn(async () => ({
  kind: 'text' as const,
  text: 'Отвечаю.',
  humorizable: true,
}));

vi.mock('../src/llm/assistant.js', () => ({ runAssistant: runAssistantMock }));

async function load(env: Record<string, string> = {}) {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  delete process.env.ENABLE_INLINE;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  vi.resetModules();
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
  return {
    inline: await import('../src/bot/handlers/onInlineQuery.js'),
    users: await import('../src/db/repos/users.repo.js'),
  };
}

interface Answered {
  results: unknown[];
  other: Record<string, unknown>;
}

interface InlineEdit {
  inlineMessageId: string;
  payload: unknown;
}

const answered: Answered[] = [];
const edits: InlineEdit[] = [];

function queryCtx(opts: { userId: number; query: string }): Context {
  return {
    me: { username: 'sec_bot' },
    inlineQuery: { id: 'q1', from: { id: opts.userId, first_name: 'Аня' }, query: opts.query },
    answerInlineQuery: async (results: unknown[], other: Record<string, unknown>) => {
      answered.push({ results, other });
      return true;
    },
  } as unknown as Context;
}

function chosenCtx(opts: {
  userId: number;
  query: string;
  inlineMessageId?: string;
  resultId?: string;
}): Context {
  return {
    me: { username: 'sec_bot' },
    chosenInlineResult: {
      result_id: opts.resultId ?? 'ask',
      from: { id: opts.userId, first_name: 'Аня', username: 'anya' },
      query: opts.query,
      inline_message_id: opts.inlineMessageId,
    },
    api: {
      editMessageTextInline: async (id: string, payload: unknown) => {
        edits.push({ inlineMessageId: id, payload });
        return true;
      },
    },
  } as unknown as Context;
}

beforeEach(() => {
  runAssistantMock.mockClear();
  answered.length = 0;
  edits.length = 0;
});
afterEach(async () => {
  const { closeDb } = await import('../src/db/client.js');
  closeDb();
});

describe('prompt pin', () => {
  it('SYSTEM_PROMPT explains the inline marker verbatim', async () => {
    await load();
    const { SYSTEM_PROMPT, INLINE_QUERY_MARKER } = await import('../src/llm/prompts.js');
    expect(SYSTEM_PROMPT).toContain(INLINE_QUERY_MARKER);
  });
});

describe('onInlineQuery access gate', () => {
  it('serves the ask-card to an approved user, without calling the LLM', async () => {
    const { inline, users } = await load();
    users.upsertStatus(5, 'approved', 1);

    await inline.onInlineQuery(queryCtx({ userId: 5, query: 'когда у Гоши днюха?' }));

    expect(runAssistantMock).not.toHaveBeenCalled();
    expect(answered).toHaveLength(1);
    const results = answered[0]!.results as {
      id: string;
      description: string;
      input_message_content: { message_text: string };
      reply_markup?: unknown;
    }[];
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe('ask');
    expect(results[0]!.description).toBe('когда у Гоши днюха?');
    // Placeholder carries the question (the target chat never saw it otherwise)…
    expect(results[0]!.input_message_content.message_text).toContain('когда у Гоши днюха?');
    // …and the stub keyboard, without which Telegram never sends inline_message_id.
    expect(results[0]!.reply_markup).toBeTruthy();
    // Personal + uncached: another user typing the same query must not get this card.
    expect(answered[0]!.other.is_personal).toBe(true);
    expect(answered[0]!.other.cache_time).toBe(0);
  });

  it('answers a stranger with an empty stub — no card, no LLM', async () => {
    const { inline } = await load();

    await inline.onInlineQuery(queryCtx({ userId: 999, query: 'привет' }));

    expect(runAssistantMock).not.toHaveBeenCalled();
    expect(answered).toHaveLength(1);
    expect(answered[0]!.results).toHaveLength(0);
    const button = answered[0]!.other.button as { text: string };
    expect(button.text).toContain('закрыт');
  });

  it('an empty query gets a hint button, not a card', async () => {
    const { inline, users } = await load();
    users.upsertStatus(5, 'approved', 1);

    await inline.onInlineQuery(queryCtx({ userId: 5, query: '   ' }));

    expect(answered[0]!.results).toHaveLength(0);
    expect(answered[0]!.other.button).toBeTruthy();
  });

  it('ENABLE_INLINE=false answers empty so the client stops spinning', async () => {
    const { inline, users } = await load({ ENABLE_INLINE: 'false' });
    users.upsertStatus(5, 'approved', 1);

    await inline.onInlineQuery(queryCtx({ userId: 5, query: 'вопрос' }));

    expect(answered).toHaveLength(1);
    expect(answered[0]!.results).toHaveLength(0);
  });
});

describe('onChosenInlineResult', () => {
  it('runs the assistant read-only with the DM context and edits the answer in', async () => {
    const { inline, users } = await load();
    users.upsertStatus(5, 'approved', 1);

    await inline.onChosenInlineResult(
      chosenCtx({ userId: 5, query: 'когда у Гоши днюха?', inlineMessageId: 'im-1' }),
    );

    expect(runAssistantMock).toHaveBeenCalledTimes(1);
    const call = runAssistantMock.mock.calls[0]![0] as unknown as {
      userContent: string;
      splidConnected: boolean;
      allowRemember: boolean;
      allowRules: boolean;
      allowReminders: boolean;
      allowWatch: boolean;
      senderName: string;
    };
    const { INLINE_QUERY_MARKER } = await import('../src/llm/prompts.js');
    // The marker is what lets the model know this is a one-shot posted elsewhere.
    expect(call.userContent).toBe(`${INLINE_QUERY_MARKER}\nкогда у Гоши днюха?`);
    expect(call.senderName).toBe('Аня');
    // Read-only: no writes, no expense flow (there is no confirm UI inline).
    expect(call.splidConnected).toBe(false);
    expect(call.allowRemember).toBe(false);
    expect(call.allowRules).toBe(false);
    expect(call.allowReminders).toBe(false);
    expect(call.allowWatch).toBe(false);

    expect(edits).toHaveLength(1);
    expect(edits[0]!.inlineMessageId).toBe('im-1');
    // Rich-markdown edit carries the question and the answer.
    const payload = edits[0]!.payload as { markdown: string };
    expect(payload.markdown).toContain('когда у Гоши днюха?');
    expect(payload.markdown).toContain('Отвечаю.');
  });

  it('ignores a pick without inline_message_id (feedback misconfigured)', async () => {
    const { inline, users } = await load();
    users.upsertStatus(5, 'approved', 1);

    await inline.onChosenInlineResult(chosenCtx({ userId: 5, query: 'вопрос' }));

    expect(runAssistantMock).not.toHaveBeenCalled();
    expect(edits).toHaveLength(0);
  });

  it('never runs the assistant for a user whose approval was revoked', async () => {
    const { inline } = await load();

    await inline.onChosenInlineResult(
      chosenCtx({ userId: 999, query: 'вопрос', inlineMessageId: 'im-2' }),
    );

    expect(runAssistantMock).not.toHaveBeenCalled();
    expect(edits).toHaveLength(0);
  });

  it('edits an apology in when the assistant call fails', async () => {
    const { inline, users } = await load();
    users.upsertStatus(5, 'approved', 1);
    runAssistantMock.mockRejectedValueOnce(new Error('boom'));

    await inline.onChosenInlineResult(
      chosenCtx({ userId: 5, query: 'вопрос', inlineMessageId: 'im-3' }),
    );

    expect(edits).toHaveLength(1);
    expect(String(edits[0]!.payload)).toContain('Не получилось');
  });
});

describe('answer shaping', () => {
  it('keeps the question above the answer', async () => {
    const { inline } = await load();
    expect(inline.inlineMessageText('вопрос', 'ответ')).toBe('❓ вопрос\n\nответ');
  });

  it('clamps an overlong answer under the Telegram message cap', async () => {
    const { inline } = await load();
    const long = 'ы'.repeat(5000);
    const clamped = inline.clampInlineAnswer(long);
    expect(clamped.length).toBeLessThan(4000);
    expect(clamped).toContain('в личку');
    // A short answer passes through untouched.
    expect(inline.clampInlineAnswer('коротко')).toBe('коротко');
  });
});
