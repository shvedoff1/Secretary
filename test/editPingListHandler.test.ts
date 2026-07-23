import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The worded roster edit («добавь @vasya в основной пинг») rides on this handler.
// Its confirmations feed straight back into the model's reply, so they must never
// carry raw @usernames — that would re-ping the very people being talked about.

async function load() {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  vi.resetModules();
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
  const assist = await import('../src/bot/flows/assist.js');
  const repo = await import('../src/db/repos/pingList.repo.js');
  return { assist, repo };
}

let closeDb: () => void;
afterEach(async () => {
  if (closeDb) closeDb();
});
beforeEach(async () => {
  ({ closeDb } = await import('../src/db/client.js'));
});

describe('makeEditPingListHandler', () => {
  it('adds several members at once to the default list, confirming without @', async () => {
    const { assist, repo } = await load();
    const handler = assist.makeEditPingListHandler(1, 42);
    const out = handler({ action: 'add', list: null, members: ['@vasya', '@petya'] });

    expect(repo.getPingList(1, 'dota')).toEqual(['@vasya', '@petya']);
    expect(out).toContain('vasya');
    expect(out).toContain('petya');
    expect(out).not.toContain('@vasya'); // no raw mention in the confirmation
    expect(out).toContain('/ping');
  });

  it('targets a named list and lower-cases it (same list as the /ping command)', async () => {
    const { assist, repo } = await load();
    const handler = assist.makeEditPingListHandler(1, 42);
    handler({ action: 'add', list: 'Стак', members: ['@kolya'] });
    expect(repo.getPingList(1, 'стак')).toEqual(['@kolya']);
  });

  it('removes members and reports how many remain', async () => {
    const { assist, repo } = await load();
    const handler = assist.makeEditPingListHandler(1, 42);
    handler({ action: 'add', list: null, members: ['@vasya', '@petya'] });
    const out = handler({ action: 'remove', list: null, members: ['@vasya'] });

    expect(repo.getPingList(1, 'dota')).toEqual(['@petya']);
    expect(out).toContain('vasya');
    expect(out).not.toContain('@vasya');
  });

  it('says so when nothing matched instead of pretending success', async () => {
    const { assist } = await load();
    const handler = assist.makeEditPingListHandler(1, 42);
    const dupFirst = handler({ action: 'add', list: null, members: ['@vasya'] });
    expect(dupFirst).toContain('Добавил');

    const dup = handler({ action: 'add', list: null, members: ['@vasya'] });
    expect(dup).toContain('уже в составе');

    const miss = handler({ action: 'remove', list: null, members: ['@nobody'] });
    expect(miss).toContain('не нашёл');
  });
});
