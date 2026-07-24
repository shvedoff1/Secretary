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

  it('mute: stores the user’s exact ask (weekdays before 19, Sunday 18-21, MSK default)', async () => {
    const { assist, repo } = await load();
    const handler = assist.makeEditPingListHandler(1, 42);
    const out = handler({
      action: 'mute',
      list: null,
      members: ['@vasya'],
      mute: [
        { days: [1, 2, 3, 4, 5], from: '00:00', to: '19:00' },
        { days: [7], from: '18:00', to: '21:00' },
      ],
      timezone: null, // default must land on Moscow
    });

    const rules = repo.getMuteRules(1, '@vasya');
    expect(rules).toHaveLength(2);
    expect(rules[0]).toEqual({
      days: [1, 2, 3, 4, 5],
      fromMin: 0,
      toMin: 1140,
      timezone: 'Europe/Moscow',
    });
    expect(rules[1]).toEqual({ days: [7], fromMin: 1080, toMin: 1260, timezone: 'Europe/Moscow' });
    // Confirmation is readable and @-free.
    expect(out).toContain('vasya');
    expect(out).not.toContain('@vasya');
    expect(out).toContain('будни до 19:00');
  });

  it('mute: keeps an explicitly named valid timezone, rejects malformed times', async () => {
    const { assist, repo } = await load();
    const handler = assist.makeEditPingListHandler(1, 42);
    handler({
      action: 'mute',
      list: null,
      members: ['@vasya'],
      mute: [{ days: [6], from: '10:00', to: '12:00' }],
      timezone: 'Asia/Makassar',
    });
    expect(repo.getMuteRules(1, '@vasya')[0]!.timezone).toBe('Asia/Makassar');

    const bad = handler({
      action: 'mute',
      list: null,
      members: ['@vasya'],
      mute: [{ days: [1], from: '25:99', to: '19:00' }],
      timezone: null,
    });
    expect(bad).toContain('Не понял время');
    // The malformed call must not have replaced the stored rules.
    expect(repo.getMuteRules(1, '@vasya')[0]!.timezone).toBe('Asia/Makassar');
  });

  it('mute with replace:false APPENDS a window to the existing schedule', async () => {
    const { assist, repo } = await load();
    const handler = assist.makeEditPingListHandler(1, 42);
    handler({
      action: 'mute',
      list: null,
      members: ['@vasya'],
      mute: [{ days: [1, 2, 3, 4, 5], from: '00:00', to: '19:00' }],
      timezone: null,
      replace: true,
    });
    const out = handler({
      action: 'mute',
      list: null,
      members: ['@vasya'],
      mute: [{ days: [6], from: '08:00', to: '12:00' }],
      timezone: null,
      replace: false,
    });

    const rules = repo.getMuteRules(1, '@vasya');
    expect(rules).toHaveLength(2); // old weekday window survived
    expect(out).toContain('Дополнил');
    // The confirmation shows the RESULTING schedule, both windows.
    expect(out).toContain('будни до 19:00');
    expect(out).toContain('сб 8:00–12:00');
  });

  it('mute with replace:true rewrites the whole schedule', async () => {
    const { assist, repo } = await load();
    const handler = assist.makeEditPingListHandler(1, 42);
    handler({
      action: 'mute',
      list: null,
      members: ['@vasya'],
      mute: [
        { days: [1, 2, 3, 4, 5], from: '00:00', to: '19:00' },
        { days: [7], from: '18:00', to: '21:00' },
      ],
      timezone: null,
      replace: true,
    });
    const out = handler({
      action: 'mute',
      list: null,
      members: ['@vasya'],
      mute: [{ days: [1, 2, 3, 4, 5], from: '00:00', to: '18:00' }],
      timezone: null,
      replace: true,
    });

    const rules = repo.getMuteRules(1, '@vasya');
    expect(rules).toHaveLength(1); // sunday window is gone — full restatement
    expect(rules[0]!.toMin).toBe(18 * 60);
    expect(out).toContain('Переписал');
  });

  it('an omitted replace flag defaults to append (never silently wipes rules), with dedup', async () => {
    const { assist, repo } = await load();
    const handler = assist.makeEditPingListHandler(1, 42);
    const win = { days: [7], from: '18:00', to: '21:00' };
    handler({ action: 'mute', list: null, members: ['@vasya'], mute: [win], timezone: null });
    // Same ask again without the flag: nothing piles up, nothing is lost.
    handler({ action: 'mute', list: null, members: ['@vasya'], mute: [win], timezone: null });
    expect(repo.getMuteRules(1, '@vasya')).toHaveLength(1);
  });

  it('unmute clears the windows and says so; unmuting a clean member is honest', async () => {
    const { assist, repo } = await load();
    const handler = assist.makeEditPingListHandler(1, 42);
    handler({
      action: 'mute',
      list: null,
      members: ['@vasya'],
      mute: [{ days: [1], from: '00:00', to: '19:00' }],
      timezone: null,
    });
    const out = handler({ action: 'unmute', list: null, members: ['@vasya'] });
    expect(out).toContain('Снял');
    expect(repo.getMuteRules(1, '@vasya')).toEqual([]);

    const noop = handler({ action: 'unmute', list: null, members: ['@petya'] });
    expect(noop).toContain('не было');
  });

  it('rename: fixes the mention in every list and carries the mute rules over', async () => {
    const { assist, repo } = await load();
    const handler = assist.makeEditPingListHandler(1, 42);
    handler({ action: 'add', list: null, members: ['@ФилиппФилипп'] });
    handler({ action: 'add', list: 'стак', members: ['@ФилиппФилипп', '@vasya'] });
    handler({
      action: 'mute',
      list: null,
      members: ['@ФилиппФилипп'],
      mute: [{ days: [1, 2, 3, 4, 5], from: '00:00', to: '19:00' }],
      timezone: null,
      replace: true,
    });

    const out = handler({
      action: 'rename',
      list: null,
      members: ['@ФилиппФилипп'],
      renameTo: '@philipp',
    });

    expect(repo.getPingList(1, 'dota')).toEqual(['@philipp']);
    expect(repo.getPingList(1, 'стак')).toEqual(['@philipp', '@vasya']);
    // The quiet hours followed the rename.
    expect(repo.getMuteRules(1, '@philipp')).toHaveLength(1);
    expect(repo.getMuteRules(1, '@ФилиппФилипп')).toEqual([]);
    // Confirmation is defanged and mentions the rules moving.
    expect(out).toContain('ФилиппФилипп → philipp');
    expect(out).not.toContain('@philipp');
    expect(out).toContain('правила тишины переехали');
  });

  it('rename: folds into an existing target instead of duplicating, honest on a miss', async () => {
    const { assist, repo } = await load();
    const handler = assist.makeEditPingListHandler(1, 42);
    handler({ action: 'add', list: null, members: ['@old', '@new'] });
    handler({ action: 'rename', list: null, members: ['@old'], renameTo: '@new' });
    expect(repo.getPingList(1, 'dota')).toEqual(['@new']); // no duplicate row

    const miss = handler({ action: 'rename', list: null, members: ['@ghost'], renameTo: '@x' });
    expect(miss).toContain('Не нашёл');

    const noTarget = handler({ action: 'rename', list: null, members: ['@new'] });
    expect(noTarget).toContain('на какой ник');
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
