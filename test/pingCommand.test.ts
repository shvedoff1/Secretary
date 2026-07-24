import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Context } from 'grammy';

// The post-ping lesson is LLM-generated in production; here the generator is
// mocked (default: null → canned fallback) so the command tests stay offline.
const lessonMock = vi.fn(async (_recent: { name: string; text: string }[]) => null as string | null);
vi.mock('../src/llm/pingLesson.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm/pingLesson.js')>();
  return { ...actual, generatePingLesson: lessonMock };
});

type PingModule = typeof import('../src/bot/commands/ping.js');

async function load(): Promise<PingModule> {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  vi.resetModules();
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
  return import('../src/bot/commands/ping.js');
}

let closeDb: () => void;
afterEach(async () => {
  if (closeDb) closeDb();
});
beforeEach(async () => {
  lessonMock.mockClear();
  lessonMock.mockResolvedValue(null);
  ({ closeDb } = await import('../src/db/client.js'));
});

function makeCtx(match: string, chatId = 10, userId = 5) {
  const replies: string[] = [];
  const ctx = {
    chat: { id: chatId, type: 'group' },
    from: { id: userId },
    match,
    message: {},
    reply: async (text: string) => {
      replies.push(text);
      return {};
    },
  } as unknown as Context;
  return { ctx, replies };
}

const ZWSP = '​';

describe('/ping command', () => {
  it('pinging an empty default list explains how to fill it', async () => {
    const ping = await load();
    const { ctx, replies } = makeCtx('');
    await ping.cmdPing(ctx);
    expect(replies[0]).toContain('пуст');
    expect(replies[0]).toContain('/ping add');
  });

  it('add + ping: roll call with every member and an opener, then a lesson as a SECOND message', async () => {
    const ping = await load();
    const add = makeCtx('add @vasya @petya');
    await ping.cmdPing(add.ctx);
    // The confirmation shows who was added, but defanged (no accidental ping).
    expect(add.replies[0]).toContain(`@${ZWSP}vasya`);

    const roll = makeCtx('');
    await ping.cmdPing(roll.ctx);
    expect(roll.replies).toHaveLength(2);
    const [call, lesson] = roll.replies as [string, string];
    // The roll call pings for real: raw usernames, no zero-width defusing.
    expect(call).toContain('@vasya @petya');
    expect(call).not.toContain(ZWSP);
    expect(ping.PING_CALLS.some((p) => call.startsWith(p))).toBe(true);
    // Generator returned null (mock default) → the canned fallback lesson.
    expect(ping.PING_LESSONS).toContain(lesson);
    expect(lesson).not.toContain('@');
  });

  it('sends the GENERATED lesson when the model delivers, feeding it the recent chatter', async () => {
    const ping = await load();
    const { recordChatMessage } = await import('../src/bot/recentChat.js');
    recordChatMessage(10, 'Вася', 'опять мид слили');
    lessonMock.mockResolvedValue('Урок по свежей теме: мид не слит, он стратегически сдан в аренду.');

    await ping.cmdPing(makeCtx('add @vasya').ctx);
    const roll = makeCtx('');
    await ping.cmdPing(roll.ctx);

    expect(roll.replies[1]).toBe('Урок по свежей теме: мид не слит, он стратегически сдан в аренду.');
    // The generator saw the chat's recent messages (the chime's ring buffer).
    const recent = lessonMock.mock.calls.at(-1)![0];
    expect(recent.some((r) => r.text.includes('опять мид слили'))).toBe(true);
  });

  it('falls back to a canned lesson when the generator itself throws', async () => {
    const ping = await load();
    lessonMock.mockRejectedValue(new Error('api down'));
    await ping.cmdPing(makeCtx('add @vasya').ctx);
    const roll = makeCtx('');
    await ping.cmdPing(roll.ctx);
    // The ping lands AND the lesson still arrives — from the canned pool.
    expect(roll.replies[0]).toContain('@vasya');
    expect(roll.replies).toHaveLength(2);
    expect(ping.PING_LESSONS).toContain(roll.replies[1]);
  });

  it('supports multiple named lists: /ping <список> pings only that list', async () => {
    const ping = await load();
    await ping.cmdPing(makeCtx('add @vasya').ctx);
    await ping.cmdPing(makeCtx('add стак @petya @kolya').ctx);

    const roll = makeCtx('стак');
    await ping.cmdPing(roll.ctx);
    expect(roll.replies[0]).toContain('@petya @kolya');
    expect(roll.replies[0]).not.toContain('@vasya');
  });

  it('show is a dry run: roster rendered with defanged mentions, nobody pinged', async () => {
    const ping = await load();
    await ping.cmdPing(makeCtx('add @vasya @petya').ctx);

    const show = makeCtx('show');
    await ping.cmdPing(show.ctx);
    expect(show.replies).toHaveLength(1); // no lesson after a dry run
    const msg = show.replies[0]!;
    expect(msg).toContain('без пинга');
    expect(msg).toContain(`@${ZWSP}vasya`);
    expect(msg).toContain(`@${ZWSP}petya`);
    // No raw pingable mention survives.
    expect(msg).not.toMatch(/@vasya/u);
  });

  it('show works for a named list and the Russian alias «состав»', async () => {
    const ping = await load();
    await ping.cmdPing(makeCtx('add стак @petya').ctx);
    const show = makeCtx('состав стак');
    await ping.cmdPing(show.ctx);
    expect(show.replies[0]).toContain(`@${ZWSP}petya`);

    const empty = makeCtx('show');
    await ping.cmdPing(empty.ctx);
    expect(empty.replies[0]).toContain('пуст');
  });

  it('del removes a member; the roll call reflects it', async () => {
    const ping = await load();
    await ping.cmdPing(makeCtx('add @vasya @petya').ctx);
    const del = makeCtx('del @vasya');
    await ping.cmdPing(del.ctx);
    expect(del.replies[0]).toContain(`@${ZWSP}vasya`);

    const roll = makeCtx('');
    await ping.cmdPing(roll.ctx);
    expect(roll.replies[0]).toContain('@petya');
    expect(roll.replies[0]).not.toContain('@vasya');
  });

  it('lists shows every list with defanged members', async () => {
    const ping = await load();
    await ping.cmdPing(makeCtx('add @vasya').ctx);
    await ping.cmdPing(makeCtx('add стак @petya').ctx);

    const lists = makeCtx('lists');
    await ping.cmdPing(lists.ctx);
    const msg = lists.replies[0]!;
    expect(msg).toContain('dota');
    expect(msg).toContain('стак');
    expect(msg).toContain(`@${ZWSP}vasya`);
    expect(msg).toContain(`@${ZWSP}petya`);
  });

  it('clear drops a whole list', async () => {
    const ping = await load();
    await ping.cmdPing(makeCtx('add стак @petya @kolya').ctx);
    const clear = makeCtx('clear стак');
    await ping.cmdPing(clear.ctx);
    expect(clear.replies[0]).toContain('стак');

    const roll = makeCtx('стак');
    await ping.cmdPing(roll.ctx);
    expect(roll.replies[0]).toContain('пуст');
  });

  it('understands the Russian aliases (добавь/убери/списки)', async () => {
    const ping = await load();
    await ping.cmdPing(makeCtx('добавь @vasya').ctx);
    const lists = makeCtx('списки');
    await ping.cmdPing(lists.ctx);
    expect(lists.replies[0]).toContain(`@${ZWSP}vasya`);

    await ping.cmdPing(makeCtx('убери @vasya').ctx);
    const roll = makeCtx('');
    await ping.cmdPing(roll.ctx);
    expect(roll.replies[0]).toContain('пуст');
  });

  it('add without members asks who to add', async () => {
    const ping = await load();
    const { ctx, replies } = makeCtx('add');
    await ping.cmdPing(ctx);
    expect(replies[0]).toContain('Кого добавлять');
  });

  it('re-adding an existing member reports nothing new', async () => {
    const ping = await load();
    await ping.cmdPing(makeCtx('add @vasya').ctx);
    const again = makeCtx('add @VASYA');
    await ping.cmdPing(again.ctx);
    expect(again.replies[0]).toContain('и так в составе');
  });

  it('ping lists are per chat', async () => {
    const ping = await load();
    await ping.cmdPing(makeCtx('add @vasya', 10).ctx);
    const other = makeCtx('', 20);
    await ping.cmdPing(other.ctx);
    expect(other.replies[0]).toContain('пуст');
  });

  it('a stray multi-word ping shows the usage help', async () => {
    const ping = await load();
    const { ctx, replies } = makeCtx('что то непонятное тут');
    await ping.cmdPing(ctx);
    expect(replies[0]).toContain('Как пользоваться');
  });

  it('the ping still lands even when the lesson message fails to send', async () => {
    const ping = await load();
    await ping.cmdPing(makeCtx('add @vasya').ctx);

    const replies: string[] = [];
    let calls = 0;
    const ctx = {
      chat: { id: 10, type: 'group' },
      from: { id: 5 },
      match: '',
      message: {},
      reply: async (text: string) => {
        calls++;
        if (calls > 1) throw new Error('flood limit');
        replies.push(text);
        return {};
      },
    } as unknown as Context;
    await expect(ping.cmdPing(ctx)).resolves.toBeUndefined();
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain('@vasya');
  });

  it('defangMention breaks the mention but keeps it readable', async () => {
    const ping = await load();
    expect(ping.defangMention('@vasya')).toBe(`@${ZWSP}vasya`);
    expect(ping.defangMention('вася')).toBe('вася');
  });
});

// An always-on window (all days, whole day) so mute state is deterministic.
const ALWAYS = [{ days: [1, 2, 3, 4, 5, 6, 7], fromMin: 0, toMin: 1440, timezone: 'Europe/Moscow' }];

describe('/ping quiet hours', () => {
  it('leaves a muted member out of the roll call, noting them defanged', async () => {
    const ping = await load();
    const repo = await import('../src/db/repos/pingList.repo.js');
    await ping.cmdPing(makeCtx('add @vasya @petya').ctx);
    repo.setMuteRules(10, '@vasya', ALWAYS);

    const roll = makeCtx('');
    await ping.cmdPing(roll.ctx);
    const call = roll.replies[0]!;
    expect(call).toContain('@petya'); // still pinged for real
    expect(call).toContain(`@${ZWSP}vasya`); // spared, defanged in the note
    expect(call).toContain('не бужу');
    expect(call).not.toMatch(/(^|[^​])@vasya/u); // no raw pingable mention
  });

  it('when EVERYONE is muted, nothing pings and no lesson follows', async () => {
    const ping = await load();
    const repo = await import('../src/db/repos/pingList.repo.js');
    await ping.cmdPing(makeCtx('add @vasya').ctx);
    repo.setMuteRules(10, '@vasya', ALWAYS);

    const roll = makeCtx('');
    await ping.cmdPing(roll.ctx);
    expect(roll.replies).toHaveLength(1); // announcement only, no lesson
    expect(roll.replies[0]).toContain('беззвучном');
    expect(roll.replies[0]).toContain(`@${ZWSP}vasya`);
  });

  it('show prints the member’s quiet-hours rules', async () => {
    const ping = await load();
    const repo = await import('../src/db/repos/pingList.repo.js');
    await ping.cmdPing(makeCtx('add @vasya @petya').ctx);
    repo.setMuteRules(10, '@vasya', [
      { days: [1, 2, 3, 4, 5], fromMin: 0, toMin: 1140, timezone: 'Europe/Moscow' },
    ]);

    const show = makeCtx('show');
    await ping.cmdPing(show.ctx);
    const msg = show.replies[0]!;
    expect(msg).toContain('Правила тишины');
    expect(msg).toContain('будни до 19:00');
    expect(msg).toContain(`@${ZWSP}vasya`);
  });
});
