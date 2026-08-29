import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vi } from 'vitest';

// Fresh in-memory DB per test; repo imported after env + module reset so it binds
// to the freshly-opened database.
async function fresh() {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  vi.resetModules();
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
  return await import('../src/db/repos/calendar.repo.js');
}

let closeDb: () => void;
beforeEach(async () => {
  ({ closeDb } = await import('../src/db/client.js'));
});
afterEach(() => {
  if (closeDb) closeDb();
});

const URL_A = 'https://calendar.google.com/calendar/ical/a%40gmail.com/private-deadbeef/basic.ics';

function sampleEvent(over: Partial<{ uid: string; startsAt: number }> = {}) {
  return {
    uid: 'e1',
    title: 'Событие',
    location: null,
    description: null,
    startsAt: 1000,
    endsAt: 2000,
    allDay: false,
    ...over,
  };
}

describe('calendar repo', () => {
  it('adds, lists and force-fetches calendars per chat', async () => {
    const repo = await fresh();
    const id = repo.addCalendar({ chatId: 1, tgUserId: 7, name: 'личный', icsUrl: URL_A });
    expect(repo.listCalendars(1).map((c) => c.id)).toEqual([id]);
    expect(repo.listCalendars(2)).toEqual([]);
    expect(repo.findCalendarByUrl(1, `webcal://${URL_A.slice('https://'.length)}`)?.id).toBe(id);
    expect(repo.forceFetch(1)).toBe(1);
    expect(repo.forceFetch(2)).toBe(0);
    expect(repo.dueCalendars(Date.now()).map((c) => c.id)).toEqual([id]);
  });

  it('ISOLATES events between chats — reads are chat-scoped', async () => {
    const repo = await fresh();
    const a = repo.addCalendar({ chatId: 1, tgUserId: null, name: 'a', icsUrl: URL_A });
    const b = repo.addCalendar({ chatId: 2, tgUserId: null, name: 'b', icsUrl: `${URL_A}2` });
    repo.replaceEvents(a, 1, [sampleEvent({ uid: 'chat1-secret' })]);
    repo.replaceEvents(b, 2, [sampleEvent({ uid: 'chat2-secret' })]);

    expect(repo.listEvents(1, 0, 10_000).map((e) => e.uid)).toEqual(['chat1-secret']);
    expect(repo.listEvents(2, 0, 10_000).map((e) => e.uid)).toEqual(['chat2-secret']);
    expect(repo.chatsWithCalendars().sort()).toEqual([1, 2]);
  });

  it('scopes deletion to the owning chat and wipes the cached events with it', async () => {
    const repo = await fresh();
    const a = repo.addCalendar({ chatId: 1, tgUserId: null, name: 'a', icsUrl: URL_A });
    repo.replaceEvents(a, 1, [sampleEvent()]);

    // Another chat cannot delete it…
    expect(repo.deleteCalendar(a, 999)).toBe(false);
    expect(repo.listCalendars(1)).toHaveLength(1);
    // …its own chat can, and the events go too.
    expect(repo.deleteCalendar(a, 1)).toBe(true);
    expect(repo.listCalendars(1)).toEqual([]);
    expect(repo.listEvents(1, 0, 10_000)).toEqual([]);
  });

  it('replaceEvents swaps the window wholesale', async () => {
    const repo = await fresh();
    const a = repo.addCalendar({ chatId: 1, tgUserId: null, name: 'a', icsUrl: URL_A });
    repo.replaceEvents(a, 1, [sampleEvent({ uid: 'old' })]);
    repo.replaceEvents(a, 1, [sampleEvent({ uid: 'new1' }), sampleEvent({ uid: 'new2', startsAt: 1500 })]);
    expect(repo.listEvents(1, 0, 10_000).map((e) => e.uid)).toEqual(['new1', 'new2']);
  });

  it('records fetch outcomes (ok keeps last_ok_at, failure keeps counting)', async () => {
    const repo = await fresh();
    const a = repo.addCalendar({ chatId: 1, tgUserId: null, name: 'a', icsUrl: URL_A });
    repo.setFetchResult(a, { ok: true, nowMs: 100, nextFetchAt: 500, failCount: 0 });
    let cal = repo.listCalendars(1)[0]!;
    expect(cal.lastOkAt).toBe(100);
    expect(cal.nextFetchAt).toBe(500);
    repo.setFetchResult(a, { ok: false, nowMs: 600, nextFetchAt: 900, failCount: 3 });
    cal = repo.listCalendars(1)[0]!;
    expect(cal.lastOkAt).toBe(100); // unchanged by a failure
    expect(cal.failCount).toBe(3);
    expect(repo.dueCalendars(899)).toEqual([]);
  });

  it('dedupes notice slots per chat and prunes old ones', async () => {
    const repo = await fresh();
    expect(repo.wasNoticeSent(1, 'evening:2026-08-30')).toBe(false);
    repo.markNoticeSent(1, 'evening:2026-08-30', 1000);
    repo.markNoticeSent(1, 'evening:2026-08-30', 2000); // idempotent
    expect(repo.wasNoticeSent(1, 'evening:2026-08-30')).toBe(true);
    // Another chat's identical slot is separate.
    expect(repo.wasNoticeSent(2, 'evening:2026-08-30')).toBe(false);
    expect(repo.pruneNotices(5000)).toBe(1);
    expect(repo.wasNoticeSent(1, 'evening:2026-08-30')).toBe(false);
  });

  it('masks the secret URL beyond recognition', async () => {
    const repo = await fresh();
    const masked = repo.maskIcsUrl(URL_A);
    expect(masked).toContain('calendar.google.com');
    expect(masked).not.toContain('deadbeef');
    expect(masked.length).toBeLessThan(50);
  });
});
