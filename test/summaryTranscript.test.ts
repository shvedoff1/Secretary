import { describe, it, expect } from 'vitest';
import type { LoggedMessage } from '../src/db/repos/chatLog.repo.js';
import {
  MAX_LINE_CHARS,
  planCondense,
  renderTranscript,
  resolveSummaryWindow,
} from '../src/summary/transcript.js';

const TZ = 'Europe/Moscow';
const BOUNDS = { defaultLimit: 200, maxLimit: 500 };
// 2026-08-21 12:00 UTC = 15:00 Moscow.
const NOW = Date.UTC(2026, 7, 21, 12, 0);

function msg(over: Partial<LoggedMessage> & { content: string; createdAt: number }): LoggedMessage {
  return {
    id: 1,
    role: 'user',
    kind: 'text',
    tgUserId: 7,
    senderName: 'Гоша',
    ...over,
  };
}

describe('resolveSummaryWindow', () => {
  it('defaults to the recent-N window when nothing is asked for', () => {
    const w = resolveSummaryWindow({ limit: null, fromDate: null, toDate: null }, TZ, NOW, BOUNDS);
    expect(w).toMatchObject({ limit: 200, fromMs: null, toMs: null });
    expect(w.label).toBe('последние 200 сообщений');
  });

  it('honours an explicit count', () => {
    const w = resolveSummaryWindow({ limit: 200, fromDate: null, toDate: null }, TZ, NOW, BOUNDS);
    expect(w.limit).toBe(200);
    expect(w.fromMs).toBeNull();
  });

  it('clamps an oversized count — the transcript has to fit the context window', () => {
    const w = resolveSummaryWindow({ limit: 5000, fromDate: null, toDate: null }, TZ, NOW, BOUNDS);
    expect(w.limit).toBe(500);
  });

  it('resolves a single local day into UTC bounds', () => {
    const w = resolveSummaryWindow(
      { limit: null, fromDate: '2026-08-20', toDate: '2026-08-20' },
      TZ,
      NOW,
      BOUNDS,
    );
    // Moscow is UTC+3 year-round: the local day starts at 21:00 UTC the day before.
    expect(w.fromMs).toBe(Date.UTC(2026, 7, 19, 21, 0));
    expect(w.toMs).toBe(Date.UTC(2026, 7, 20, 21, 0));
    expect(w.label).toBe('20 августа');
    // No count given with a range => read as much of it as the cap allows.
    expect(w.limit).toBe(500);
  });

  it('normalises a reversed range and labels a span', () => {
    const w = resolveSummaryWindow(
      { limit: null, fromDate: '2026-08-21', toDate: '2026-08-19' },
      TZ,
      NOW,
      BOUNDS,
    );
    expect(w.fromMs! < w.toMs!).toBe(true);
    expect(w.label).toBe('19 августа — 21 августа');
  });

  it('lets a count cap a date range', () => {
    const w = resolveSummaryWindow(
      { limit: 20, fromDate: '2026-08-20', toDate: null },
      TZ,
      NOW,
      BOUNDS,
    );
    expect(w.limit).toBe(20);
    expect(w.fromMs).not.toBeNull();
  });
});

describe('renderTranscript', () => {
  it('renders author, local time and channel, with a day separator', () => {
    const rendered = renderTranscript(
      [
        msg({ content: 'погнали на серф', createdAt: Date.UTC(2026, 7, 20, 6, 5) }),
        msg({ content: 'я за', kind: 'voice', senderName: 'Ира', createdAt: Date.UTC(2026, 7, 21, 7, 30) }),
        msg({ content: 'волны метр', role: 'assistant', senderName: null, createdAt: Date.UTC(2026, 7, 21, 7, 31) }),
      ],
      { tz: TZ, charBudget: 10_000 },
    );
    expect(rendered.text.split('\n')).toEqual([
      '— 20 августа —',
      '[09:05] Гоша: погнали на серф',
      '— 21 августа —',
      '[10:30] Ира (голосовое): я за',
      '[10:31] Бот: волны метр',
    ]);
    expect(rendered).toMatchObject({ used: 3, dropped: 0 });
  });

  it('flattens newlines so one message stays one line', () => {
    const rendered = renderTranscript(
      [msg({ content: 'план:\n- волны\n- кофе', createdAt: NOW })],
      { tz: TZ, charBudget: 1000 },
    );
    expect(rendered.text).toContain('план: ⏎ - волны ⏎ - кофе');
    expect(rendered.text.split('\n')).toHaveLength(2); // day separator + the line
  });

  it('cuts an over-long single message instead of letting it eat the window', () => {
    const rendered = renderTranscript([msg({ content: 'я'.repeat(2000), createdAt: NOW })], {
      tz: TZ,
      charBudget: 10_000,
    });
    expect(rendered.text).toContain('[обрезано]');
    expect(rendered.text.length).toBeLessThan(MAX_LINE_CHARS + 100);
  });

  it('drops the OLDEST lines when the budget is tight and reports how many', () => {
    const messages = Array.from({ length: 10 }, (_, i) =>
      msg({ content: `сообщение ${i}`, createdAt: NOW + i * 60_000 }),
    );
    const rendered = renderTranscript(messages, { tz: TZ, charBudget: 120 });
    expect(rendered.dropped).toBeGreaterThan(0);
    expect(rendered.used + rendered.dropped).toBe(10);
    // The newest line always survives; the oldest is what goes.
    expect(rendered.text).toContain('сообщение 9');
    expect(rendered.text).not.toContain('сообщение 0');
  });

  it('keeps at least the newest line even with an absurdly small budget', () => {
    const rendered = renderTranscript(
      [msg({ content: 'старое', createdAt: NOW }), msg({ content: 'новое', createdAt: NOW + 1000 })],
      { tz: TZ, charBudget: 1 },
    );
    expect(rendered.used).toBe(1);
    expect(rendered.text).toContain('новое');
  });

  it('renders nothing for an empty window', () => {
    expect(renderTranscript([], { tz: TZ, charBudget: 100 })).toEqual({
      text: '',
      used: 0,
      dropped: 0,
    });
  });
});

describe('planCondense', () => {
  // The split behind «перескажи последние 500 сообщений»: compress the old part,
  // keep the recent part word-for-word.
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      msg({ content: `реплика ${String(i).padStart(3, '0')}`, createdAt: NOW + i * 60_000 }),
    );

  it('keeps the newest messages verbatim and chunks the rest oldest-first', () => {
    const plan = planCondense(many(60), { tz: TZ, tailChars: 200, chunkChars: 300, maxChunks: 20 });

    expect(plan.tailCount).toBeGreaterThan(0);
    expect(plan.tail).toContain('реплика 059');
    expect(plan.dropped).toBe(0);
    expect(plan.condensedCount + plan.tailCount).toBe(60);
    // Chunks run oldest → newest, and each chunk is itself chronological.
    expect(plan.chunks[0]).toContain('реплика 000');
    expect(plan.chunks.at(-1)).not.toContain('реплика 000');
    const first = plan.chunks[0]!.split('\n').filter((l) => l.startsWith('['));
    expect(first[0]! < first[first.length - 1]!).toBe(true);
    // Nothing is both condensed and verbatim.
    expect(plan.chunks.join('\n')).not.toContain('реплика 059');
  });

  it('respects the per-chunk size so one compression call stays cheap', () => {
    const plan = planCondense(many(60), { tz: TZ, tailChars: 100, chunkChars: 300, maxChunks: 20 });
    for (const chunk of plan.chunks) expect(chunk.length).toBeLessThanOrEqual(400);
  });

  it('drops the OLDEST material when the window exceeds the chunk cap', () => {
    const plan = planCondense(many(60), { tz: TZ, tailChars: 100, chunkChars: 300, maxChunks: 2 });
    expect(plan.chunks).toHaveLength(2);
    expect(plan.dropped).toBeGreaterThan(0);
    expect(plan.chunks.join('\n')).not.toContain('реплика 000');
    // What survives is the newest end, as everywhere else in the skill.
    expect(plan.tail).toContain('реплика 059');
  });

  it('handles a window with nothing to condense', () => {
    const plan = planCondense(many(2), { tz: TZ, tailChars: 10_000, chunkChars: 300, maxChunks: 5 });
    expect(plan.chunks).toEqual([]);
    expect(plan.tailCount).toBe(2);
    expect(planCondense([], { tz: TZ, tailChars: 100, chunkChars: 100, maxChunks: 2 })).toMatchObject({
      chunks: [],
      tail: '',
      dropped: 0,
    });
  });
});
