import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The set_timezone tool — the «я во Вьетнаме» flow. The chat timezone drives
// reminders, calendar digests and time display, so a plain statement of where
// the user is must be enough to move the clock.
async function fresh() {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  vi.resetModules();
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
  const flows = await import('../src/bot/flows/assist.js');
  const settings = await import('../src/db/repos/chatSettings.repo.js');
  return { flows, settings };
}

let closeDb: () => void;
beforeEach(async () => {
  ({ closeDb } = await import('../src/db/client.js'));
});
afterEach(() => {
  if (closeDb) closeDb();
});

describe('set_timezone handler', () => {
  it('persists a valid IANA zone and confirms with the local time', async () => {
    const { flows, settings } = await fresh();
    const run = flows.makeSetTimezoneHandler(1);
    const res = run({ timezone: 'Asia/Ho_Chi_Minh', place: 'Вьетнам' });
    expect(res).toContain('Asia/Ho_Chi_Minh');
    expect(res).toContain('Вьетнам');
    expect(res).toContain('локальное время');
    expect(settings.getTimezone(1)).toBe('Asia/Ho_Chi_Minh');
  });

  it('refuses an invalid zone without touching the stored one', async () => {
    const { flows, settings } = await fresh();
    settings.setTimezone(1, 'Europe/Moscow');
    const res = flows.makeSetTimezoneHandler(1)({ timezone: 'Vietnam/Saigon', place: null });
    expect(res).toContain('Не понял зону');
    expect(settings.getTimezone(1)).toBe('Europe/Moscow');
  });

  it('is chat-scoped', async () => {
    const { flows, settings } = await fresh();
    flows.makeSetTimezoneHandler(1)({ timezone: 'Asia/Makassar', place: 'Бали' });
    expect(settings.getTimezone(1)).toBe('Asia/Makassar');
    expect(settings.getTimezone(2)).toBeNull();
  });
});

describe('set_timezone exposure', () => {
  it('is on by default and switchable off (scheduled/inline)', async () => {
    const { buildTools, SET_TIMEZONE_TOOL } = await import('../src/llm/tools.js');
    const names = (opts: Parameters<typeof buildTools>[0]) =>
      buildTools(opts).map((t) => ('name' in t ? t.name : ''));
    expect(names({ enableWebSearch: false, enableExpense: false })).toContain(
      SET_TIMEZONE_TOOL,
    );
    expect(
      names({ enableWebSearch: false, enableExpense: false, enableTimezone: false }),
    ).not.toContain(SET_TIMEZONE_TOOL);
  });

  it('is explained in the system prompt', async () => {
    const { SYSTEM_PROMPT } = await import('../src/llm/prompts.js');
    expect(SYSTEM_PROMPT).toContain('set_timezone');
    expect(SYSTEM_PROMPT).toContain('Asia/Ho_Chi_Minh');
  });
});
