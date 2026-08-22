// Pure logic for the chat-summary skill: resolving the window of messages to read
// and rendering them as a transcript for the model. No DB / bot / network here (the
// orchestration lives in ./handler.ts), so the fiddly parts — the char budget, the
// day separators, the "how many lines were cut" bookkeeping — are unit-testable.

import type { LoggedMessage } from '../db/repos/chatLog.repo.js';
import { previousDateStr, startOfZonedDayMs, zonedDayRange, zonedParts } from '../util/day.js';

export interface SummaryWindowInput {
  /** How many of the most recent messages to read; null => the caller's default. */
  limit: number | null;
  /** Inclusive start day (YYYY-MM-DD, chat-local), or null. */
  fromDate: string | null;
  /** Inclusive end day (YYYY-MM-DD, chat-local), or null. */
  toDate: string | null;
}

export interface ResolvedWindow {
  /** Max messages to read, counted from the NEWEST end of the window. */
  limit: number;
  /** UTC bounds, or null for "no time bound — just the last `limit` messages". */
  fromMs: number | null;
  toMs: number | null;
  /** Human label for the transcript header, e.g. «21 августа» or «последние 200 сообщений». */
  label: string;
}

/** Format one local calendar day as "21 августа" in the given timezone. */
export function humanDay(dateStr: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      timeZone: tz,
      day: 'numeric',
      month: 'long',
    }).format(new Date(startOfZonedDayMs(dateStr, tz)));
  } catch {
    return dateStr;
  }
}

/**
 * Resolve the model's (possibly empty) window request into concrete bounds.
 *
 * Two shapes, because that's how people ask: a COUNT («что было в последних 200
 * сообщениях») reads the last N messages with no time bound, while DATES («о чём
 * болтали вчера») read a local-day range. Dates win when both are given: the count
 * then only caps how much of that range is read. `limit` is always clamped to
 * `maxLimit` — the transcript lands in the model's context window, so an unbounded
 * ask must not be able to blow it.
 */
export function resolveSummaryWindow(
  input: SummaryWindowInput,
  tz: string,
  nowMs: number,
  bounds: { defaultLimit: number; maxLimit: number },
): ResolvedWindow {
  const clamp = (n: number): number => Math.max(1, Math.min(Math.floor(n), bounds.maxLimit));

  if (input.fromDate || input.toDate) {
    let fromDate = input.fromDate ?? input.toDate!;
    let toDate = input.toDate ?? fromDate;
    if (fromDate > toDate) [fromDate, toDate] = [toDate, fromDate];
    const fromMs = zonedDayRange(fromDate, tz).fromMs;
    const toMs = zonedDayRange(toDate, tz).toMs;
    const label =
      fromDate === toDate
        ? humanDay(fromDate, tz)
        : `${humanDay(fromDate, tz)} — ${humanDay(toDate, tz)}`;
    // No count given with a date range => read as much of it as the cap allows.
    return { limit: clamp(input.limit ?? bounds.maxLimit), fromMs, toMs, label };
  }

  const limit = clamp(input.limit ?? bounds.defaultLimit);
  return {
    limit,
    fromMs: null,
    toMs: null,
    label: `последние ${limit} сообщений`,
  };
}

/** "Вчера" in the chat's timezone, as YYYY-MM-DD — handy for callers/tests. */
export function yesterdayIn(tz: string, nowMs: number): string {
  return previousDateStr(zonedParts(nowMs, tz).dateStr);
}

/** Longest a single message may take in the transcript before it is cut. */
export const MAX_LINE_CHARS = 600;

export interface RenderedTranscript {
  text: string;
  /** Lines actually rendered. */
  used: number;
  /** Oldest lines dropped to fit the char budget (0 when everything fit). */
  dropped: number;
}

function speaker(msg: LoggedMessage): string {
  if (msg.role === 'assistant') return 'Бот';
  return msg.senderName?.trim() || 'Кто-то';
}

function channelTag(kind: LoggedMessage['kind']): string {
  if (kind === 'voice') return ' (голосовое)';
  if (kind === 'photo') return ' (фото)';
  return '';
}

function oneLine(msg: LoggedMessage, tz: string): string {
  const { hour, minute } = zonedParts(msg.createdAt, tz);
  const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  // Newlines inside one message would look like separate speakers in the transcript.
  const body = msg.content.replace(/\s*\n+\s*/g, ' ⏎ ').trim();
  const cut =
    body.length > MAX_LINE_CHARS ? `${body.slice(0, MAX_LINE_CHARS)}… [обрезано]` : body;
  return `[${time}] ${speaker(msg)}${channelTag(msg.kind)}: ${cut}`;
}

/**
 * Render logged messages (oldest first) as a plain-text transcript with day
 * separators, bounded by `charBudget`.
 *
 * When the budget is tight the OLDEST lines are dropped, never the newest: a
 * summary that misses the start of the day is useful, one that misses what was just
 * said is not. The count of dropped lines is returned so the caller can tell the
 * model the transcript is partial — silently truncating would have it summarise a
 * window it thinks is complete.
 */
export function renderTranscript(
  messages: LoggedMessage[],
  opts: { tz: string; charBudget: number },
): RenderedTranscript {
  if (messages.length === 0) return { text: '', used: 0, dropped: 0 };

  // Build newest-first while the budget allows, then flip back to chronological.
  const kept: { line: string; dateStr: string }[] = [];
  let size = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    const line = oneLine(msg, opts.tz);
    // +1 for the newline, plus slack for the day separator this line may pull in.
    if (size + line.length + 1 > opts.charBudget && kept.length > 0) break;
    size += line.length + 1;
    kept.push({ line, dateStr: zonedParts(msg.createdAt, opts.tz).dateStr });
  }
  kept.reverse();

  const out: string[] = [];
  let currentDay = '';
  for (const entry of kept) {
    if (entry.dateStr !== currentDay) {
      currentDay = entry.dateStr;
      out.push(`— ${humanDay(entry.dateStr, opts.tz)} —`);
    }
    out.push(entry.line);
  }
  return { text: out.join('\n'), used: kept.length, dropped: messages.length - kept.length };
}
