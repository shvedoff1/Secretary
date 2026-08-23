import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Context } from 'grammy';

// /rules — the explicit list-and-edit view over the chat's standing behaviour
// rules — plus the `set_rule` handler behind the plain-words flow («с этого
// момента …»). Both write the same table, so both are pinned here.

// Env must be set BEFORE the module reset: the db client and the config are both
// module-level singletons, so migrating and then resetting would hand the test a
// fresh (empty) database.
async function freshDb(env: Record<string, string> = {}) {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  delete process.env.CHAT_RULES_MAX;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  vi.resetModules();
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
}

let closeDb: () => void;
afterEach(async () => {
  if (closeDb) closeDb();
});
beforeEach(async () => {
  ({ closeDb } = await import('../src/db/client.js'));
});

function ctxFor(match: string, opts: { fromId?: number; chatId?: number } = {}) {
  const replies: string[] = [];
  const ctx = {
    from: { id: opts.fromId ?? 1 },
    chat: { id: opts.chatId ?? opts.fromId ?? 1, type: 'private' },
    match,
    reply: async (t: string) => {
      replies.push(t);
      return {};
    },
    api: { sendMessage: async (_id: number, t: string) => replies.push(t) },
  } as unknown as Context;
  return { ctx, replies };
}

describe('/rules argument parsing', () => {
  it('reads a leading chat id only when a sub-command follows', async () => {
    const { parseRulesArgs } = await import('../src/bot/commands/rules.js');
    expect(parseRulesArgs('-100500 add Без эмодзи')).toEqual({
      chatId: -100500,
      rest: 'add Без эмодзи',
    });
    expect(parseRulesArgs('-100500')).toEqual({ chatId: -100500, rest: '' });
    expect(parseRulesArgs('add Без эмодзи')).toEqual({ chatId: null, rest: 'add Без эмодзи' });
    // A rule text may itself start with a number — that must not be eaten as an id.
    expect(parseRulesArgs('add 5 минут на ответ')).toEqual({
      chatId: null,
      rest: 'add 5 минут на ответ',
    });
  });
});

describe('/rules', () => {
  it('explains what a rule is when the chat has none', async () => {
    await freshDb();
    const { cmdRules } = await import('../src/bot/commands/rules.js');
    const { ctx, replies } = ctxFor('');
    await cmdRules(ctx);
    expect(replies[0]).toContain('Правил пока нет');
    expect(replies[0]).toContain('/rules add');
  });

  it('adds a rule, lists it numbered, and deletes it by that number', async () => {
    await freshDb();
    const { cmdRules } = await import('../src/bot/commands/rules.js');
    const repo = await import('../src/db/repos/chatRule.repo.js');

    const add = ctxFor('add Все голосовые расшифровывай и чисти от слов-паразитов');
    await cmdRules(add.ctx);
    expect(add.replies[0]).toContain('Правило записано');
    expect(repo.listRules(1).map((r) => r.text)).toEqual([
      'Все голосовые расшифровывай и чисти от слов-паразитов',
    ]);

    const list = ctxFor('');
    await cmdRules(list.ctx);
    expect(list.replies[0]).toContain('1. Все голосовые расшифровывай');

    const del = ctxFor('del 1');
    await cmdRules(del.ctx);
    expect(del.replies[0]).toContain('Убрал');
    expect(repo.listRules(1)).toEqual([]);
  });

  it('rejects a bad delete index instead of dropping the wrong rule', async () => {
    await freshDb();
    const { cmdRules } = await import('../src/bot/commands/rules.js');
    const repo = await import('../src/db/repos/chatRule.repo.js');
    repo.addRule({ chatId: 1, text: 'Без эмодзи', max: 30 });

    for (const arg of ['del 2', 'del 0', 'del']) {
      const { ctx, replies } = ctxFor(arg);
      await cmdRules(ctx);
      expect(replies[0]).toContain('Использование');
    }
    expect(repo.countRules(1)).toBe(1);
  });

  it('clears the chat and reports the duplicate/cap cases', async () => {
    await freshDb({ CHAT_RULES_MAX: '1' });
    const { cmdRules } = await import('../src/bot/commands/rules.js');
    const repo = await import('../src/db/repos/chatRule.repo.js');

    await cmdRules(ctxFor('add Без эмодзи').ctx);
    const dup = ctxFor('add без эмодзи');
    await cmdRules(dup.ctx);
    expect(dup.replies[0]).toContain('уже есть');

    const full = ctxFor('add Отвечай короче');
    await cmdRules(full.ctx);
    expect(full.replies[0]).toContain('максимум');
    expect(repo.countRules(1)).toBe(1);

    const clear = ctxFor('clear');
    await cmdRules(clear.ctx);
    expect(clear.replies[0]).toContain('очищены');
    expect(repo.countRules(1)).toBe(0);
  });

  it('lets the admin manage another chat from the DM, but nobody else', async () => {
    await freshDb();
    const { cmdRules } = await import('../src/bot/commands/rules.js');
    const users = await import('../src/db/repos/users.repo.js');
    const repo = await import('../src/db/repos/chatRule.repo.js');
    users.ensureAdmin(1); // user 7 stays a plain (non-admin) user

    const admin = ctxFor('-100500 add Без эмодзи', { fromId: 1 });
    await cmdRules(admin.ctx);
    expect(repo.listRules(-100500).map((r) => r.text)).toEqual(['Без эмодзи']);

    const stranger = ctxFor('-100500 add Пиши стихами', { fromId: 7 });
    await cmdRules(stranger.ctx);
    expect(stranger.replies[0]).toContain('только его админ');
    expect(repo.countRules(-100500)).toBe(1);
  });
});

describe('set_rule handler (the plain-words flow)', () => {
  it('adds, refuses a duplicate, and reports the cap', async () => {
    await freshDb({ CHAT_RULES_MAX: '1' });
    const { makeSetRuleHandler } = await import('../src/bot/flows/assist.js');
    const handle = makeSetRuleHandler(-42, 7);

    expect(handle({ action: 'add', text: 'Отвечай короче' })).toContain('Записал правило');
    expect(handle({ action: 'add', text: 'Отвечай короче' })).toContain('уже действует');
    expect(handle({ action: 'add', text: 'Без эмодзи' })).toContain('максимум');
  });

  it('removes a rule quoted back in the model\'s own words', async () => {
    await freshDb();
    const { makeSetRuleHandler } = await import('../src/bot/flows/assist.js');
    const repo = await import('../src/db/repos/chatRule.repo.js');
    const handle = makeSetRuleHandler(-42, 7);
    handle({ action: 'add', text: 'Все голосовые расшифровывай и чисти от слов-паразитов' });

    const reply = handle({ action: 'remove', text: 'голосовые расшифровывай' });
    expect(reply).toContain('Убрал правило');
    expect(repo.listRules(-42)).toEqual([]);
  });

  it('says so instead of guessing when the quoted rule is unknown', async () => {
    await freshDb();
    const { makeSetRuleHandler } = await import('../src/bot/flows/assist.js');
    const repo = await import('../src/db/repos/chatRule.repo.js');
    const handle = makeSetRuleHandler(-42, 7);
    handle({ action: 'add', text: 'Отвечай короче' });

    expect(handle({ action: 'remove', text: 'пиши стихами' })).toContain('Не нашёл');
    expect(repo.countRules(-42)).toBe(1);
  });
});
