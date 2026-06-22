import { describe, it, expect } from 'vitest';
import {
  nextRunMs,
  isValidSchedule,
  isValidTimezone,
} from '../src/util/schedule.js';
import { ScheduleTaskZ } from '../src/llm/schema.js';

describe('schedule util', () => {
  it('computes the next run strictly after the given time', () => {
    const after = new Date('2026-06-21T06:00:00.000Z');
    // 09:00 every day in UTC.
    const next = nextRunMs('0 9 * * *', 'UTC', after);
    expect(next).toBe(new Date('2026-06-21T09:00:00.000Z').getTime());
  });

  it('rolls over to the next day when the time already passed', () => {
    const after = new Date('2026-06-21T10:00:00.000Z');
    const next = nextRunMs('0 9 * * *', 'UTC', after);
    expect(next).toBe(new Date('2026-06-22T09:00:00.000Z').getTime());
  });

  it('honors the timezone (09:00 Europe/Lisbon is 08:00 UTC in summer)', () => {
    const after = new Date('2026-06-21T00:00:00.000Z');
    const next = nextRunMs('0 9 * * *', 'Europe/Lisbon', after);
    expect(next).toBe(new Date('2026-06-21T08:00:00.000Z').getTime());
  });

  it('returns null for an invalid cron expression', () => {
    expect(nextRunMs('not a cron', 'UTC')).toBeNull();
  });

  it('validates cron + timezone pairs', () => {
    expect(isValidSchedule('0 9 * * *', 'UTC')).toBe(true);
    expect(isValidSchedule('nonsense', 'UTC')).toBe(false);
    expect(isValidSchedule('0 9 * * *', 'Mars/Olympus')).toBe(false);
  });

  it('validates IANA timezones', () => {
    expect(isValidTimezone('Europe/Lisbon')).toBe(true);
    expect(isValidTimezone('Not/AZone')).toBe(false);
  });
});

describe('ScheduleTaskZ', () => {
  it('accepts a well-formed task', () => {
    const res = ScheduleTaskZ.safeParse({
      title: 'Прогноз волн',
      prompt: 'Найди прогноз по волнам для Эрисейры и кратко напиши',
      cron: '0 8 * * *',
      timezone: 'Europe/Lisbon',
      once: false,
    });
    expect(res.success).toBe(true);
  });

  it('rejects missing fields', () => {
    const res = ScheduleTaskZ.safeParse({ title: 'x', cron: '0 8 * * *' });
    expect(res.success).toBe(false);
  });
});
