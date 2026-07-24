import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  parseHHMM,
  isMutedAt,
  describeWindows,
  type MuteWindow,
} from '../src/util/pingMute.js';

// Fixed instants (UTC) for deterministic tz math. Moscow is UTC+3 year-round.
// 2026-07-22 is a Wednesday; 2026-07-26 is a Sunday.
const WED_18_MSK = new Date('2026-07-22T15:00:00Z'); // 18:00 среда МСК
const WED_19_30_MSK = new Date('2026-07-22T16:30:00Z'); // 19:30 среда МСК
const SUN_18_30_MSK = new Date('2026-07-26T15:30:00Z'); // 18:30 воскресенье МСК
const SUN_21_30_MSK = new Date('2026-07-26T18:30:00Z'); // 21:30 воскресенье МСК
const SAT_10_MSK = new Date('2026-07-25T07:00:00Z'); // 10:00 суббота МСК

// The user's exact ask: weekdays before 19:00 + Sunday 18:00-21:00, Moscow time.
const WEEKDAYS_BEFORE_19: MuteWindow = {
  days: [1, 2, 3, 4, 5],
  fromMin: 0,
  toMin: 19 * 60,
  timezone: 'Europe/Moscow',
};
const SUNDAY_18_21: MuteWindow = {
  days: [7],
  fromMin: 18 * 60,
  toMin: 21 * 60,
  timezone: 'Europe/Moscow',
};

describe('parseHHMM', () => {
  it('parses valid times including the 24:00 end-of-day bound', () => {
    expect(parseHHMM('00:00')).toBe(0);
    expect(parseHHMM('9:05')).toBe(545);
    expect(parseHHMM('19:00')).toBe(1140);
    expect(parseHHMM('24:00')).toBe(1440);
  });

  it('rejects garbage', () => {
    expect(parseHHMM('25:00')).toBeNull();
    expect(parseHHMM('12:60')).toBeNull();
    expect(parseHHMM('вечером')).toBeNull();
    expect(parseHHMM('24:30')).toBeNull();
  });
});

describe('isMutedAt — the «до 19:00 будни, вс 18-21 по мск» case', () => {
  const rules = [WEEKDAYS_BEFORE_19, SUNDAY_18_21];

  it('mutes on a weekday before 19:00 Moscow time', () => {
    expect(isMutedAt(rules, WED_18_MSK)).toBe(true);
  });

  it('does not mute on a weekday after 19:00', () => {
    expect(isMutedAt(rules, WED_19_30_MSK)).toBe(false);
  });

  it('mutes on Sunday inside 18:00-21:00 and releases after', () => {
    expect(isMutedAt(rules, SUN_18_30_MSK)).toBe(true);
    expect(isMutedAt(rules, SUN_21_30_MSK)).toBe(false);
  });

  it('Saturday is free — no window covers it', () => {
    expect(isMutedAt(rules, SAT_10_MSK)).toBe(false);
  });
});

describe('isMutedAt — edge shapes', () => {
  it('respects the window timezone, not the server clock', () => {
    // Same instant, same wall window, different zone: 15:00Z is 18:00 in Moscow
    // but 23:00 in Asia/Makassar (UTC+8) — a "before 19:00" window only bites
    // in the Moscow variant.
    const makassar: MuteWindow = { ...WEEKDAYS_BEFORE_19, timezone: 'Asia/Makassar' };
    expect(isMutedAt([WEEKDAYS_BEFORE_19], WED_18_MSK)).toBe(true);
    expect(isMutedAt([makassar], WED_18_MSK)).toBe(false);
  });

  it('handles overnight wrap (23:00-07:00): late evening and next morning both muted', () => {
    const night: MuteWindow = {
      days: [3], // armed on Wednesdays
      fromMin: 23 * 60,
      toMin: 7 * 60,
      timezone: 'Europe/Moscow',
    };
    const wedLate = new Date('2026-07-22T20:30:00Z'); // ср 23:30 МСК
    const thuMorning = new Date('2026-07-23T03:00:00Z'); // чт 06:00 МСК
    const thuLate = new Date('2026-07-23T20:30:00Z'); // чт 23:30 МСК — not armed
    expect(isMutedAt([night], wedLate)).toBe(true);
    expect(isMutedAt([night], thuMorning)).toBe(true);
    expect(isMutedAt([night], thuLate)).toBe(false);
  });

  it('an unknown timezone never mutes (fail-open, people stay reachable)', () => {
    const broken: MuteWindow = { ...WEEKDAYS_BEFORE_19, timezone: 'Nowhere/Land' };
    expect(isMutedAt([broken], WED_18_MSK)).toBe(false);
  });

  it('empty rules never mute', () => {
    expect(isMutedAt([], WED_18_MSK)).toBe(false);
  });
});

describe('describeWindows', () => {
  it('renders the classic case compactly', () => {
    const out = describeWindows([WEEKDAYS_BEFORE_19, SUNDAY_18_21]);
    expect(out).toContain('будни до 19:00');
    expect(out).toContain('вс 18:00–21:00');
    expect(out).toContain('Europe/Moscow');
  });

  it('renders open-ended and every-day shapes', () => {
    const out = describeWindows([
      { days: [1, 2, 3, 4, 5, 6, 7], fromMin: 22 * 60, toMin: 1440, timezone: 'Europe/Moscow' },
    ]);
    expect(out).toContain('каждый день с 22:00');
  });
});

// --- repo round-trip ---------------------------------------------------------

async function freshRepo() {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  vi.resetModules();
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
  return import('../src/db/repos/pingList.repo.js');
}

let closeDb: () => void;
afterEach(async () => {
  if (closeDb) closeDb();
});
beforeEach(async () => {
  ({ closeDb } = await import('../src/db/client.js'));
});

describe('mute rules repo', () => {
  it('round-trips windows and normalizes the member key (@Vasya == vasya)', async () => {
    const repo = await freshRepo();
    repo.setMuteRules(1, '@Vasya', [WEEKDAYS_BEFORE_19, SUNDAY_18_21]);
    const got = repo.getMuteRules(1, 'vasya');
    expect(got).toHaveLength(2);
    expect(got[0]).toEqual(WEEKDAYS_BEFORE_19);
    expect(got[1]).toEqual(SUNDAY_18_21);
  });

  it('setMuteRules REPLACES previous windows, clearMuteRules drops them', async () => {
    const repo = await freshRepo();
    repo.setMuteRules(1, '@vasya', [WEEKDAYS_BEFORE_19, SUNDAY_18_21]);
    repo.setMuteRules(1, '@vasya', [SUNDAY_18_21]);
    expect(repo.getMuteRules(1, '@vasya')).toHaveLength(1);
    expect(repo.clearMuteRules(1, 'VASYA')).toBe(1);
    expect(repo.getMuteRules(1, '@vasya')).toEqual([]);
  });

  it('is per chat and lists all rules keyed by member', async () => {
    const repo = await freshRepo();
    repo.setMuteRules(1, '@vasya', [SUNDAY_18_21]);
    repo.setMuteRules(2, '@vasya', [WEEKDAYS_BEFORE_19]);
    expect(repo.getMuteRules(2, '@vasya')).toEqual([WEEKDAYS_BEFORE_19]);
    const all = repo.listMuteRules(1);
    expect([...all.keys()]).toEqual(['vasya']);
    expect(all.get('vasya')).toEqual([SUNDAY_18_21]);
  });
});
