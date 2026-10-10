// Pure logic for the chat-summary skill: resolving the window of messages to read
// and rendering them as a transcript for the model. No DB / bot / network here (the
// orchestration lives in ./handler.ts), so the fiddly parts — the char budget, the
// day separators, the "how many lines were cut" bookkeeping — are unit-testable.

import type { LoggedMessage } from '../db/repos/chatLog.repo.js';
import { messageLink } from '../util/telegramLink.js';
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
  if (kind === 'file') return ' (файл)';
  if (kind === 'video') return ' (видео)';
  return '';
}

/**
 * How lines are decorated beyond «[time] Author: text». Everything is optional so
 * the plain shape (episode notes, old callers) stays exactly as it was.
 */
export interface LineOptions {
  tz: string;
  /** The chat the lines belong to — needed to build t.me links. */
  chatId?: number;
  /** Tag each line with its forum topic («{QA}») — for a window spanning topics. */
  topicNames?: ReadonlyMap<number, string> | null;
  /**
   * Which lines get a link back to their source message: 'media' (voice / photo /
   * video / file — the lines worth citing, and the ones the reader can't re-read
   * in text) or 'all' (a focused ask like bug candidates, where any line may be
   * the one to cite). Default: none.
   */
  links?: 'none' | 'media' | 'all';
}

function asOptions(opts: string | LineOptions): LineOptions {
  return typeof opts === 'string' ? { tz: opts } : opts;
}

function topicTag(msg: LoggedMessage, names: ReadonlyMap<number, string> | null | undefined): string {
  if (!names) return '';
  if (msg.threadId == null) return ' {General}';
  return ` {${names.get(msg.threadId) ?? `тред ${msg.threadId}`}}`;
}

function suffixes(msg: LoggedMessage, o: LineOptions): string {
  let out = '';
  // A media line is a REFERENCE: the picture itself stays in Telegram until
  // someone asks to look at this exact one (view_media takes the number).
  if (msg.mediaFileId) out += ` [медиа #${msg.id}]`;
  const wantLink =
    o.links === 'all' || (o.links === 'media' && (msg.kind !== 'text' || !!msg.mediaFileId));
  if (wantLink && o.chatId != null && msg.role === 'user') {
    const link = messageLink(o.chatId, msg.messageId, msg.threadId);
    if (link) out += ` ${link}`;
  }
  return out;
}

function oneLine(msg: LoggedMessage, opts: string | LineOptions): string {
  const o = asOptions(opts);
  const { hour, minute } = zonedParts(msg.createdAt, o.tz);
  const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  // Newlines inside one message would look like separate speakers in the transcript.
  const body = msg.content.replace(/\s*\n+\s*/g, ' ⏎ ').trim();
  const cut =
    body.length > MAX_LINE_CHARS ? `${body.slice(0, MAX_LINE_CHARS)}… [обрезано]` : body;
  return `[${time}]${topicTag(msg, o.topicNames)} ${speaker(msg)}${channelTag(msg.kind)}: ${cut}${suffixes(msg, o)}`;
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
  opts: LineOptions & { charBudget: number },
): RenderedTranscript {
  if (messages.length === 0) return { text: '', used: 0, dropped: 0 };
  const kept = takeNewestWithin(messages, opts, opts.charBudget);
  return {
    text: renderLines(kept, opts),
    used: kept.length,
    dropped: messages.length - kept.length,
  };
}

/**
 * Render messages (oldest first) as transcript lines with a day separator whenever
 * the local date changes. Shared by the verbatim path and the condense planner, so
 * both feed the models exactly the same shape of text.
 */
export function renderLines(messages: LoggedMessage[], opts: string | LineOptions): string {
  const o = asOptions(opts);
  const tz = o.tz;
  const out: string[] = [];
  let currentDay = '';
  for (const msg of messages) {
    const dateStr = zonedParts(msg.createdAt, tz).dateStr;
    if (dateStr !== currentDay) {
      currentDay = dateStr;
      out.push(`— ${humanDay(dateStr, tz)} —`);
    }
    out.push(oneLine(msg, o));
  }
  return out.join('\n');
}

/**
 * The newest run of messages whose rendered lines fit `charBudget` (chronological).
 * Always keeps at least the newest one: a window that can't fit even a single line
 * should still show the last thing said rather than nothing.
 */
function takeNewestWithin(
  messages: LoggedMessage[],
  tz: LineOptions,
  charBudget: number,
): LoggedMessage[] {
  const kept: LoggedMessage[] = [];
  let size = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    const cost = oneLine(msg, tz).length + 1;
    if (size + cost > charBudget && kept.length > 0) break;
    size += cost;
    kept.push(msg);
  }
  return kept.reverse();
}

export interface CondensePlan {
  /** Older part, oldest-first, split into chunks small enough for one cheap call. */
  chunks: string[];
  /** Newest messages, rendered verbatim. */
  tail: string;
  tailCount: number;
  condensedCount: number;
  /** Messages beyond the plan's reach (oldest), dropped and worth reporting. */
  dropped: number;
}

/**
 * Split a window that is too big to pass verbatim into "compress the old part,
 * keep the recent part word-for-word".
 *
 * The newest slice stays verbatim because that's what follow-up questions land on
 * («а что там про рыбалку?») and what the recap's last paragraph is about; the
 * older part is what a cheap model can compress without the recap losing anything
 * that matters. Chunks are filled from the NEWEST end so that when the window
 * exceeds `maxChunks`, what falls off is the OLDEST material — same rule as the
 * verbatim path, and reported the same way.
 */
export function planCondense(
  messages: LoggedMessage[],
  opts: LineOptions & { tailChars: number; chunkChars: number; maxChunks: number },
): CondensePlan {
  if (messages.length === 0) {
    return { chunks: [], tail: '', tailCount: 0, condensedCount: 0, dropped: 0 };
  }
  const tailMessages = takeNewestWithin(messages, opts, opts.tailChars);
  const older = messages.slice(0, messages.length - tailMessages.length);

  // Pack the older part newest-first, then flip everything back to chronological.
  const packed: LoggedMessage[][] = [];
  let current: LoggedMessage[] = [];
  let size = 0;
  for (let i = older.length - 1; i >= 0; i--) {
    const msg = older[i]!;
    const cost = oneLine(msg, opts).length + 1;
    if (current.length > 0 && size + cost > opts.chunkChars) {
      packed.push(current);
      current = [];
      size = 0;
    }
    current.push(msg);
    size += cost;
  }
  if (current.length > 0) packed.push(current);

  const within = packed.slice(0, opts.maxChunks);
  const dropped = packed
    .slice(opts.maxChunks)
    .reduce((n, chunk) => n + chunk.length, 0);
  const chunks = within
    .map((chunk) => renderLines(chunk.slice().reverse(), opts))
    .reverse();

  return {
    chunks,
    tail: renderLines(tailMessages, opts),
    tailCount: tailMessages.length,
    condensedCount: within.reduce((n, chunk) => n + chunk.length, 0),
    dropped,
  };
}

export type ThreadResolution =
  /** null = every topic; 0 = General; >0 = that topic. */
  | { ok: true; threadId: number | null; label: string | null }
  | { ok: false; error: string };

const THIS_THREAD = /^(this|current|here|этот|текущий|тут|здесь|этом|этого)(\s+(тред|топик|thread|topic)\w*)?$/i;
const GENERAL_THREAD = /^(general|общий|основной|главный|general\s+topic)(\s+(тред|топик|чат))?$/i;

/**
 * Turn the model's `thread` argument into a topic id. Forgiving the way people
 * name things («тред QA», «багрепорты», «этот тред»): exact name → numeric id →
 * a UNIQUE containment match. An ambiguous or unknown name is an error that lists
 * the known topics — guessing the wrong thread would recap the wrong conversation
 * with full confidence.
 */
export function resolveThread(
  raw: string | null | undefined,
  topics: readonly { threadId: number; name: string }[],
  currentThreadId: number | null,
): ThreadResolution {
  const want = (raw ?? '').trim().replace(/^#/, '');
  if (!want) return { ok: true, threadId: null, label: null };
  const nameOf = (id: number): string =>
    id === 0 ? 'General' : (topics.find((t) => t.threadId === id)?.name ?? `тред ${id}`);

  if (THIS_THREAD.test(want)) {
    const id = currentThreadId ?? 0;
    return { ok: true, threadId: id, label: nameOf(id) };
  }
  if (GENERAL_THREAD.test(want)) return { ok: true, threadId: 0, label: 'General' };
  if (/^\d+$/.test(want)) {
    const id = Number(want);
    return { ok: true, threadId: id, label: nameOf(id) };
  }

  const norm = (s: string): string =>
    s.toLowerCase().replace(/ё/g, 'е').replace(/^(тред|топик|thread|topic)\s+/, '').trim();
  const q = norm(want);
  const exact = topics.filter((t) => norm(t.name) === q);
  if (exact.length === 1) return { ok: true, threadId: exact[0]!.threadId, label: exact[0]!.name };
  const partial = topics.filter((t) => {
    const n = norm(t.name);
    return n.includes(q) || (n.length >= 3 && q.includes(n));
  });
  if (partial.length === 1) {
    return { ok: true, threadId: partial[0]!.threadId, label: partial[0]!.name };
  }
  const known = topics.length
    ? topics.map((t) => `«${t.name}» (id ${t.threadId})`).join(', ')
    : 'none learned yet — topic names are picked up as messages arrive';
  return {
    ok: false,
    error:
      partial.length > 1
        ? `Topic «${want}» is ambiguous: it matches ${partial.map((t) => `«${t.name}»`).join(', ')}. Ask the user which one, or retry with the exact name.`
        : `No forum topic matches «${want}». Known topics: ${known}. Retry with one of them (or its id), or ask the user which thread they mean.`,
  };
}

/**
 * The context-block line that tells the model this is a forum chat: the topics it
 * knows and the one the current message is in («что было в этом треде» needs the
 * latter). null for a chat without topics — no line, stable block shape.
 */
export function forumTopicsLine(
  topics: readonly { threadId: number; name: string }[],
  currentThreadId: number | null,
): string | null {
  if (topics.length === 0 && currentThreadId == null) return null;
  const MAX = 30;
  const shown = topics.slice(0, MAX).map((t) => `«${t.name}» (id ${t.threadId})`);
  if (topics.length > MAX) shown.push(`…+${topics.length - MAX}`);
  const here =
    currentThreadId == null
      ? 'General'
      : `«${topics.find((t) => t.threadId === currentThreadId)?.name ?? `тред ${currentThreadId}`}» (id ${currentThreadId})`;
  return `Forum topics (threads; summarize_chat.thread scopes a recap to one): ${shown.length ? shown.join(', ') : 'names not learned yet'}. This message is in: ${here}.`;
}
