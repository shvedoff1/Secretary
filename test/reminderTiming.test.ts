import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  formatLocalClock,
  cronForInstant,
  formatDelay,
} from '../src/util/schedule.js';
import { ScheduleTaskZ, ManageTaskZ } from '../src/llm/schema.js';
import { buildTools, SCHEDULE_TASK_TOOL, MANAGE_TASK_TOOL } from '../src/llm/tools.js';
import {
  SYSTEM_PROMPT,
  TUTOR_SYSTEM_PROMPT,
  currentTimeLines,
  buildContextBlock,
  buildTutorContextBlock,
} from '../src/llm/prompts.js';

// The «через час 50 → 12:25» regression: the reminder was asked at 17:33 Vietnam
// time, the model added 1:50 to the UTC clock (10:35) and labelled the result as
// local. Relative timing now goes through `inMinutes` (computed on the server),
// the context block carries a chat-local clock, and an existing reminder can be
// moved/cancelled with `manage_task` instead of a duplicate schedule_task.

// 2026-09-02 10:33 UTC == 17:33 in Asia/Ho_Chi_Minh (UTC+7).
const NOW = new Date('2026-09-02T10:33:00.000Z').getTime();
const TZ = 'Asia/Ho_Chi_Minh';

describe('schedule util (relative timing)', () => {
  it('formats the chat-local wall clock', () => {
    expect(formatLocalClock(NOW, TZ)).toBe('2026-09-02 17:33 (Wed)');
    expect(formatLocalClock(NOW, 'UTC')).toBe('2026-09-02 10:33 (Wed)');
    expect(formatLocalClock(NOW, 'Mars/Olympus')).toBeNull();
  });

  it('derives the one-shot cron of an instant in the chat zone', () => {
    // +110 min from 17:33 local = 19:23 local on the same day.
    expect(cronForInstant(NOW + 110 * 60_000, TZ)).toBe('23 19 2 9 *');
    // The same instant in UTC is 12:23 — the two crons differ, as they must.
    expect(cronForInstant(NOW + 110 * 60_000, 'UTC')).toBe('23 12 2 9 *');
    expect(cronForInstant(NOW, 'Mars/Olympus')).toBeNull();
  });

  it('crosses midnight correctly in the local zone', () => {
    // 23:50 local + 20 min => 00:10 on 3 September.
    const lateLocal = new Date('2026-09-02T16:50:00.000Z').getTime();
    expect(cronForInstant(lateLocal + 20 * 60_000, TZ)).toBe('10 0 3 9 *');
  });

  it('renders a delay for confirmations', () => {
    expect(formatDelay(3)).toBe('через 3 мин');
    expect(formatDelay(60)).toBe('через 1 ч');
    expect(formatDelay(110)).toBe('через 1 ч 50 мин');
  });
});

describe('schemas', () => {
  it('schedule_task accepts a relative reminder with cron null', () => {
    const res = ScheduleTaskZ.safeParse({
      title: 'Сушилка',
      prompt: 'Напомни забрать вещи из сушилки',
      cron: null,
      inMinutes: 110,
      timezone: TZ,
      once: true,
      humor: false,
    });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.inMinutes).toBe(110);
  });

  it('schedule_task still accepts the legacy cron-only shape', () => {
    const res = ScheduleTaskZ.safeParse({
      title: 'Кофе',
      prompt: 'Напомни выпить кофе',
      cron: '0 9 * * *',
      timezone: 'Europe/Lisbon',
      once: false,
      humor: false,
    });
    expect(res.success).toBe(true);
  });

  it('manage_task parses reschedule and cancel, rejects other actions', () => {
    expect(
      ManageTaskZ.safeParse({ action: 'reschedule', id: 15, cron: null, inMinutes: 110, timezone: null })
        .success,
    ).toBe(true);
    expect(ManageTaskZ.safeParse({ action: 'cancel', id: 15 }).success).toBe(true);
    expect(ManageTaskZ.safeParse({ action: 'edit', id: 15 }).success).toBe(false);
    expect(ManageTaskZ.safeParse({ action: 'cancel', id: 0 }).success).toBe(false);
  });
});

describe('tool exposure', () => {
  const names = (opts: Parameters<typeof buildTools>[0]) =>
    buildTools(opts).map((t) => ('name' in t ? t.name : ''));

  it('manage_task rides the same flag as schedule_task', () => {
    const on = names({ enableWebSearch: false, enableExpense: false });
    expect(on).toContain(SCHEDULE_TASK_TOOL);
    expect(on).toContain(MANAGE_TASK_TOOL);
    const off = names({ enableWebSearch: false, enableExpense: false, enableReminders: false });
    expect(off).not.toContain(SCHEDULE_TASK_TOOL);
    expect(off).not.toContain(MANAGE_TASK_TOOL);
  });

  it('schedule_task advertises inMinutes and nullable cron', () => {
    const tool = buildTools({ enableWebSearch: false, enableExpense: false }).find(
      (t) => 'name' in t && t.name === SCHEDULE_TASK_TOOL,
    ) as { input_schema: { properties: Record<string, unknown>; required: string[] } };
    expect(tool.input_schema.properties).toHaveProperty('inMinutes');
    expect(tool.input_schema.required).toContain('inMinutes');
    expect((tool.input_schema.properties.cron as { type: unknown }).type).toEqual(['string', 'null']);
  });
});

describe('prompt + context block pins', () => {
  it('the system prompts route relative timing and edits explicitly', () => {
    expect(SYSTEM_PROMPT).toContain('`inMinutes`');
    expect(SYSTEM_PROMPT).toContain('`manage_task`');
    expect(SYSTEM_PROMPT).toContain('Current time (chat-local)');
    expect(TUTOR_SYSTEM_PROMPT).toContain('`inMinutes`');
    expect(TUTOR_SYSTEM_PROMPT).toContain('`manage_task`');
  });

  it('currentTimeLines carries UTC + the chat-local clock when the zone is known', () => {
    const lines = currentTimeLines(TZ, NOW);
    expect(lines[0]).toBe('Current time (UTC): 2026-09-02T10:33:00.000Z');
    expect(lines[1]).toContain(`Current time (chat-local, ${TZ}): 2026-09-02 17:33 (Wed)`);
    expect(lines[2]).toBe(`Chat timezone: ${TZ}`);
  });

  it('currentTimeLines omits the local clock when the zone is unknown', () => {
    const lines = currentTimeLines('unknown', NOW);
    expect(lines).toHaveLength(2);
    expect(lines.join('\n')).not.toContain('chat-local');
    expect(lines[1]).toBe('Chat timezone: unknown');
  });

  it('both context blocks render the chat-local clock', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const block = buildContextBlock({
        defaultCurrency: 'EUR',
        members: [],
        senderName: 'Андрей',
        timezone: TZ,
        splidConnected: false,
      });
      expect(block).toContain('Current time (chat-local, Asia/Ho_Chi_Minh): 2026-09-02 17:33 (Wed)');
      const tutor = buildTutorContextBlock({ senderName: 'Ученик', timezone: TZ });
      expect(tutor).toContain('Current time (chat-local, Asia/Ho_Chi_Minh): 2026-09-02 17:33 (Wed)');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('schedule_task + manage_task handlers', () => {
  async function fresh() {
    process.env.BOT_TOKEN = 'x';
    process.env.ANTHROPIC_API_KEY = 'x';
    process.env.ADMIN_TELEGRAM_ID = '1';
    process.env.DATABASE_PATH = ':memory:';
    vi.resetModules();
    const { migrate } = await import('../src/db/migrate.js');
    migrate();
    const flows = await import('../src/bot/flows/assist.js');
    const repo = await import('../src/db/repos/scheduledTask.repo.js');
    const { closeDb } = await import('../src/db/client.js');
    return { flows, repo, closeDb };
  }

  let close: (() => void) | undefined;
  afterEach(() => {
    close?.();
    close = undefined;
    vi.useRealTimers();
  });

  function relative(over: Record<string, unknown> = {}) {
    return {
      title: 'Забрать вещи из сушилки',
      prompt: 'Напомни забрать вещи из сушилки',
      cron: null,
      inMinutes: 110,
      timezone: TZ,
      once: true,
      humor: false,
      ...over,
    };
  }

  it('a relative reminder fires exactly now + delay, in the chat zone (the 12:25 regression)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { flows, repo, closeDb } = await fresh();
    close = closeDb;
    const res = flows.makeScheduleTaskHandler(100, 1, 'Europe/Moscow')(relative());
    expect(res).toContain('через 1 ч 50 мин');
    expect(res).toContain('19:23');
    expect(res).not.toContain('12:25');
    const [t] = repo.listTasks(100);
    expect(t!.nextRunAt).toBe(NOW + 110 * 60_000);
    expect(t!.cron).toBe('23 19 2 9 *');
    expect(t!.timezone).toBe(TZ);
    expect(t!.once).toBe(true);
  });

  it('a relative reminder is one-off even if the model said once:false', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { flows, repo, closeDb } = await fresh();
    close = closeDb;
    flows.makeScheduleTaskHandler(100, 1, 'Europe/Moscow')(relative({ once: false }));
    expect(repo.listTasks(100)[0]!.once).toBe(true);
  });

  it('refuses a call with neither cron nor delay', async () => {
    const { flows, repo, closeDb } = await fresh();
    close = closeDb;
    const res = flows.makeScheduleTaskHandler(100, 1, 'Europe/Moscow')(
      relative({ inMinutes: null, cron: null }),
    );
    expect(res).toContain('Не понял время');
    expect(repo.listTasks(100)).toHaveLength(0);
  });

  it('an absolute cron still schedules as before', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { flows, repo, closeDb } = await fresh();
    close = closeDb;
    const res = flows.makeScheduleTaskHandler(100, 1, 'Europe/Moscow')(
      relative({ inMinutes: null, cron: '0 9 * * *', once: false }),
    );
    expect(res).toContain('Регулярная задача');
    const [t] = repo.listTasks(100);
    expect(t!.cron).toBe('0 9 * * *');
    // Next 09:00 Vietnam after 17:33 local is tomorrow 02:00 UTC.
    expect(t!.nextRunAt).toBe(new Date('2026-09-03T02:00:00.000Z').getTime());
  });

  it('manage_task reschedules an existing task relatively — no duplicate left behind', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { flows, repo, closeDb } = await fresh();
    close = closeDb;
    flows.makeScheduleTaskHandler(100, 1, 'Europe/Moscow')(relative());
    const [orig] = repo.listTasks(100);

    // Six minutes later: «на 1.50 от сейчас».
    vi.setSystemTime(NOW + 6 * 60_000);
    const res = flows.makeManageTaskHandler(100, 'Europe/Moscow')({
      action: 'reschedule',
      id: orig!.id,
      cron: null,
      inMinutes: 110,
      timezone: null,
    });
    expect(res).toContain(`Перенёс #${orig!.id}`);
    expect(res).toContain('19:29');
    const tasks = repo.listTasks(100);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.id).toBe(orig!.id);
    expect(tasks[0]!.nextRunAt).toBe(NOW + 116 * 60_000);
    expect(tasks[0]!.cron).toBe('29 19 2 9 *');
    expect(tasks[0]!.title).toBe(orig!.title);
    expect(tasks[0]!.prompt).toBe(orig!.prompt);
  });

  it('manage_task reschedules to an absolute cron, keeping the task zone by default', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { flows, repo, closeDb } = await fresh();
    close = closeDb;
    flows.makeScheduleTaskHandler(100, 1, 'Europe/Moscow')(relative());
    const [orig] = repo.listTasks(100);
    const res = flows.makeManageTaskHandler(100, 'Europe/Moscow')({
      action: 'reschedule',
      id: orig!.id,
      cron: '30 19 2 9 *',
      inMinutes: null,
      timezone: null,
    });
    expect(res).toContain('19:30');
    const [t] = repo.listTasks(100);
    expect(t!.timezone).toBe(TZ);
    expect(t!.nextRunAt).toBe(new Date('2026-09-02T12:30:00.000Z').getTime());
  });

  it('manage_task cancels an existing task', async () => {
    const { flows, repo, closeDb } = await fresh();
    close = closeDb;
    flows.makeScheduleTaskHandler(100, 1, 'Europe/Moscow')(relative());
    const [orig] = repo.listTasks(100);
    const res = flows.makeManageTaskHandler(100, 'Europe/Moscow')({ action: 'cancel', id: orig!.id });
    expect(res).toContain('удалено');
    expect(res).toContain(orig!.title);
    expect(repo.listTasks(100)).toHaveLength(0);
  });

  it('manage_task is chat-scoped and reports an unknown id', async () => {
    const { flows, repo, closeDb } = await fresh();
    close = closeDb;
    flows.makeScheduleTaskHandler(100, 1, 'Europe/Moscow')(relative());
    const [orig] = repo.listTasks(100);
    const foreign = flows.makeManageTaskHandler(999, 'Europe/Moscow')({ action: 'cancel', id: orig!.id });
    expect(foreign).toContain('Не нашёл');
    expect(repo.listTasks(100)).toHaveLength(1);
    const missing = flows.makeManageTaskHandler(100, 'Europe/Moscow')({ action: 'cancel', id: 4242 });
    expect(missing).toContain('Не нашёл активное напоминание #4242');
  });

  it('manage_task refuses a reschedule with no timing and leaves the task untouched', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { flows, repo, closeDb } = await fresh();
    close = closeDb;
    flows.makeScheduleTaskHandler(100, 1, 'Europe/Moscow')(relative());
    const [orig] = repo.listTasks(100);
    const res = flows.makeManageTaskHandler(100, 'Europe/Moscow')({
      action: 'reschedule',
      id: orig!.id,
      cron: null,
      inMinutes: null,
      timezone: null,
    });
    expect(res).toContain('Не понял время');
    expect(repo.listTasks(100)[0]!.nextRunAt).toBe(orig!.nextRunAt);
  });
});
