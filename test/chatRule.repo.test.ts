import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Chat rules: the standing behaviour orders a chat sets for the bot («все
// голосовые очищай от слов-паразитов»). Unlike memory they are injected into
// EVERY turn, so the cap and the no-duplicates rule are load-bearing, not tidiness.

async function freshRepo() {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  vi.resetModules();
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
  return import('../src/db/repos/chatRule.repo.js');
}

let closeDb: () => void;
afterEach(async () => {
  if (closeDb) closeDb();
});
beforeEach(async () => {
  ({ closeDb } = await import('../src/db/client.js'));
});

describe('chat rule repo', () => {
  it('adds, lists in insertion order and counts per chat', async () => {
    const repo = await freshRepo();
    expect(repo.listRules(-100)).toEqual([]);

    repo.addRule({ chatId: -100, text: 'Отвечай короче', max: 10 });
    repo.addRule({ chatId: -100, text: 'Без эмодзи', max: 10 });
    repo.addRule({ chatId: -200, text: 'Пиши по-английски', max: 10 });

    expect(repo.listRules(-100).map((r) => r.text)).toEqual(['Отвечай короче', 'Без эмодзи']);
    expect(repo.countRules(-100)).toBe(2);
    expect(repo.listRules(-200).map((r) => r.text)).toEqual(['Пиши по-английски']);
  });

  it('trims the text and records who set it', async () => {
    const repo = await freshRepo();
    const res = repo.addRule({ chatId: 1, text: '  Без эмодзи  ', tgUserId: 42, max: 10 });
    expect(res.status).toBe('added');
    const [rule] = repo.listRules(1);
    expect(rule!.text).toBe('Без эмодзи');
    expect(rule!.tgUserId).toBe(42);
    expect(rule!.createdAt).toBeGreaterThan(0);
  });

  it('refuses a duplicate instead of doubling it in the context block', async () => {
    const repo = await freshRepo();
    repo.addRule({ chatId: 1, text: 'Отвечай короче', max: 10 });
    // Same rule, different casing/spacing/punctuation — still the same order.
    const again = repo.addRule({ chatId: 1, text: '  отвечай короче.  ', max: 10 });
    expect(again.status).toBe('duplicate');
    expect(repo.countRules(1)).toBe(1);
  });

  it('enforces the per-chat cap (rules are paid for on every turn)', async () => {
    const repo = await freshRepo();
    for (let i = 0; i < 3; i++) repo.addRule({ chatId: 1, text: `Правило ${i}`, max: 3 });
    const overflow = repo.addRule({ chatId: 1, text: 'Ещё одно', max: 3 });
    expect(overflow).toEqual({ status: 'full', max: 3 });
    expect(repo.countRules(1)).toBe(3);
    // The cap is per chat, not global.
    expect(repo.addRule({ chatId: 2, text: 'Ещё одно', max: 3 }).status).toBe('added');
  });

  it('removes by id and only within its own chat', async () => {
    const repo = await freshRepo();
    repo.addRule({ chatId: 1, text: 'Правило А', max: 10 });
    const b = repo.addRule({ chatId: 1, text: 'Правило Б', max: 10 });
    const id = b.status === 'added' ? b.rule.id : 0;

    expect(repo.removeRule(2, id)).toBeNull(); // wrong chat — untouched
    expect(repo.removeRule(1, id)).toBe('Правило Б');
    expect(repo.listRules(1).map((r) => r.text)).toEqual(['Правило А']);
    expect(repo.removeRule(1, id)).toBeNull(); // already gone
  });

  it('clears one chat only', async () => {
    const repo = await freshRepo();
    repo.addRule({ chatId: 1, text: 'А', max: 10 });
    repo.addRule({ chatId: 1, text: 'Б', max: 10 });
    repo.addRule({ chatId: 2, text: 'В', max: 10 });
    expect(repo.clearRules(1)).toBe(2);
    expect(repo.listRules(1)).toEqual([]);
    expect(repo.listRules(2)).toHaveLength(1);
  });
});

describe('findRule (used when the model cancels a rule in its own words)', () => {
  it('matches exactly, ignoring case, spacing and punctuation', async () => {
    const repo = await freshRepo();
    repo.addRule({ chatId: 1, text: 'Все голосовые расшифровывай и чисти от слов-паразитов', max: 10 });
    const found = repo.findRule(1, '«все голосовые расшифровывай и чисти от слов-паразитов».');
    expect(found?.text).toContain('голосовые');
  });

  it('matches a unique partial quote either way round', async () => {
    const repo = await freshRepo();
    repo.addRule({ chatId: 1, text: 'Все голосовые расшифровывай и чисти от слов-паразитов', max: 10 });
    repo.addRule({ chatId: 1, text: 'Отвечай короче', max: 10 });
    expect(repo.findRule(1, 'голосовые расшифровывай')?.text).toContain('голосовые');
  });

  it('returns null when the quote is ambiguous — better to ask than drop the wrong rule', async () => {
    const repo = await freshRepo();
    repo.addRule({ chatId: 1, text: 'Голосовые расшифровывай', max: 10 });
    repo.addRule({ chatId: 1, text: 'Голосовые чисти от слов-паразитов', max: 10 });
    expect(repo.findRule(1, 'голосовые')).toBeNull();
  });

  it('returns null for an unknown rule and never crosses chats', async () => {
    const repo = await freshRepo();
    repo.addRule({ chatId: 1, text: 'Отвечай короче', max: 10 });
    expect(repo.findRule(1, 'пиши стихами')).toBeNull();
    expect(repo.findRule(2, 'отвечай короче')).toBeNull();
  });
});
