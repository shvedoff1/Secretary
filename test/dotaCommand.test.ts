import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Context } from 'grammy';

type DotaModule = typeof import('../src/bot/commands/dota.js');

async function load(): Promise<DotaModule> {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  vi.resetModules();
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
  return import('../src/bot/commands/dota.js');
}

let closeDb: () => void;
afterEach(async () => {
  if (closeDb) closeDb();
});
beforeEach(async () => {
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

describe('/dota command', () => {
  it('pinging an empty default list explains how to fill it', async () => {
    const dota = await load();
    const { ctx, replies } = makeCtx('');
    await dota.cmdDota(ctx);
    expect(replies[0]).toContain('пуст');
    expect(replies[0]).toContain('/dota add');
  });

  it('add + ping: the roll call contains every member and a call-to-arms opener', async () => {
    const dota = await load();
    const add = makeCtx('add @vasya @petya');
    await dota.cmdDota(add.ctx);
    expect(add.replies[0]).toContain('@vasya');
    expect(add.replies[0]).toContain('@petya');

    const ping = makeCtx('');
    await dota.cmdDota(ping.ctx);
    const msg = ping.replies[0]!;
    expect(msg).toContain('@vasya @petya');
    // The opener is one of the canned schoolkid-sensei phrases.
    expect(dota.PING_CALLS.some((p) => msg.startsWith(p))).toBe(true);
  });

  it('supports multiple named lists: /dota <список> pings only that list', async () => {
    const dota = await load();
    await dota.cmdDota(makeCtx('add @vasya').ctx);
    await dota.cmdDota(makeCtx('add стак @petya @kolya').ctx);

    const ping = makeCtx('стак');
    await dota.cmdDota(ping.ctx);
    expect(ping.replies[0]).toContain('@petya @kolya');
    expect(ping.replies[0]).not.toContain('@vasya');
  });

  it('del removes a member; the ping reflects it', async () => {
    const dota = await load();
    await dota.cmdDota(makeCtx('add @vasya @petya').ctx);
    const del = makeCtx('del @vasya');
    await dota.cmdDota(del.ctx);
    expect(del.replies[0]).toContain('@vasya');

    const ping = makeCtx('');
    await dota.cmdDota(ping.ctx);
    expect(ping.replies[0]).toContain('@petya');
    expect(ping.replies[0]).not.toContain('@vasya');
  });

  it('lists shows every list with its members', async () => {
    const dota = await load();
    await dota.cmdDota(makeCtx('add @vasya').ctx);
    await dota.cmdDota(makeCtx('add стак @petya').ctx);

    const lists = makeCtx('lists');
    await dota.cmdDota(lists.ctx);
    const msg = lists.replies[0]!;
    expect(msg).toContain('dota');
    expect(msg).toContain('@vasya');
    expect(msg).toContain('стак');
    expect(msg).toContain('@petya');
  });

  it('clear drops a whole list', async () => {
    const dota = await load();
    await dota.cmdDota(makeCtx('add стак @petya @kolya').ctx);
    const clear = makeCtx('clear стак');
    await dota.cmdDota(clear.ctx);
    expect(clear.replies[0]).toContain('стак');

    const ping = makeCtx('стак');
    await dota.cmdDota(ping.ctx);
    expect(ping.replies[0]).toContain('пуст');
  });

  it('understands the Russian aliases (добавь/удали/списки/очисть)', async () => {
    const dota = await load();
    await dota.cmdDota(makeCtx('добавь @vasya').ctx);
    const lists = makeCtx('списки');
    await dota.cmdDota(lists.ctx);
    expect(lists.replies[0]).toContain('@vasya');

    await dota.cmdDota(makeCtx('удали @vasya').ctx);
    const ping = makeCtx('');
    await dota.cmdDota(ping.ctx);
    expect(ping.replies[0]).toContain('пуст');
  });

  it('add without members asks who to add', async () => {
    const dota = await load();
    const { ctx, replies } = makeCtx('add');
    await dota.cmdDota(ctx);
    expect(replies[0]).toContain('Кого добавлять');
  });

  it('re-adding an existing member reports nothing new', async () => {
    const dota = await load();
    await dota.cmdDota(makeCtx('add @vasya').ctx);
    const again = makeCtx('add @VASYA');
    await dota.cmdDota(again.ctx);
    expect(again.replies[0]).toContain('и так в составе');
  });

  it('ping lists are per chat', async () => {
    const dota = await load();
    await dota.cmdDota(makeCtx('add @vasya', 10).ctx);
    const other = makeCtx('', 20);
    await dota.cmdDota(other.ctx);
    expect(other.replies[0]).toContain('пуст');
  });

  it('a stray multi-word ping shows the usage help', async () => {
    const dota = await load();
    const { ctx, replies } = makeCtx('что то непонятное тут');
    await dota.cmdDota(ctx);
    expect(replies[0]).toContain('Как пользоваться');
  });
});
