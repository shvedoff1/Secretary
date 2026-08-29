import { describe, it, expect } from 'vitest';
import { buildTools, CALENDAR_EVENTS_TOOL } from '../src/llm/tools.js';
import { SYSTEM_PROMPT, buildContextBlock } from '../src/llm/prompts.js';

const baseOpts = { enableWebSearch: false, enableExpense: false } as const;

function toolNames(opts: Parameters<typeof buildTools>[0]): string[] {
  return buildTools(opts).map((t) => ('name' in t ? t.name : ''));
}

describe('calendar tool exposure', () => {
  it('is exposed only when a calendar is connected', () => {
    expect(toolNames({ ...baseOpts, enableCalendar: true })).toContain(CALENDAR_EVENTS_TOOL);
    expect(toolNames({ ...baseOpts, enableCalendar: false })).not.toContain(
      CALENDAR_EVENTS_TOOL,
    );
    // Unlike the default-on tools, absence of the flag means OFF (like dota).
    expect(toolNames(baseOpts)).not.toContain(CALENDAR_EVENTS_TOOL);
  });
});

describe('calendar prompt pins', () => {
  it('SYSTEM_PROMPT routes calendar questions to the tool and /calendar', () => {
    expect(SYSTEM_PROMPT).toContain('calendar_events');
    expect(SYSTEM_PROMPT).toContain('/calendar');
    // The no-duplicate-reminders rule: calendar events already get automatic
    // digests, so the model must not schedule_task them on its own.
    expect(SYSTEM_PROMPT).toMatch(/do NOT create a\s+`schedule_task` duplicate/);
  });

  it('context block renders the calendar section only when connected', () => {
    const base = {
      defaultCurrency: 'EUR',
      members: [],
      senderName: 'Гоша',
      timezone: 'Europe/Moscow',
      splidConnected: false,
    };
    const off = buildContextBlock(base);
    expect(off).not.toContain('Calendar:');

    const on = buildContextBlock({
      ...base,
      calendarConnected: true,
      calendarLines: ['сб, 30 августа 07:40 Самолёт в Москву — Шереметьево'],
    });
    expect(on).toContain('Calendar: connected');
    expect(on).toContain('07:40 Самолёт в Москву');
    expect(on).toContain('calendar_events');

    const empty = buildContextBlock({ ...base, calendarConnected: true, calendarLines: [] });
    expect(empty).toContain('no upcoming events');
  });

  it('the expense-only scan carries no calendar context', () => {
    const block = buildContextBlock({
      defaultCurrency: 'EUR',
      members: [],
      senderName: 'Гоша',
      timezone: 'Europe/Moscow',
      splidConnected: true,
      expenseOnly: true,
      calendarConnected: true,
      calendarLines: ['сб, 30 августа 07:40 Самолёт'],
    });
    expect(block).not.toContain('Calendar:');
    expect(block).not.toContain('Самолёт');
  });
});
