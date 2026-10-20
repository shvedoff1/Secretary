import { InlineKeyboard } from 'grammy';
import type { DayType } from '../db/repos/food.repo.js';

/** Callback data: `fdt:<YYYY-MM-DD>:<typeId>` (0 = back to the default goal). */
export const DAY_TYPE_CALLBACK_RE = /^fdt:(\d{4}-\d{2}-\d{2}):(\d+)$/;

export function dayTypeCallback(date: string, typeId: number): string {
  return `fdt:${date}:${typeId}`;
}

/** «тренировка» → «Тренировка» for a button label. */
const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/**
 * The «какой сегодня день?» buttons: one per day type (two per row), plus
 * «Обычный» for the default goal. Pure, so the layout is unit-tested.
 */
export function dayTypeKeyboard(types: DayType[], date: string, currentId: number | null = null): InlineKeyboard {
  const kb = new InlineKeyboard();
  types.forEach((t, i) => {
    kb.text(`${t.id === currentId ? '✓ ' : ''}${cap(t.name)}`, dayTypeCallback(date, t.id));
    if (i % 2 === 1) kb.row();
  });
  if (types.length % 2 === 1) kb.row();
  kb.text(`${currentId === null ? '✓ ' : ''}Обычный`, dayTypeCallback(date, 0));
  return kb;
}
