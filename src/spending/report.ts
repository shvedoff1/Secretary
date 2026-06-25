// Pure logic for the daily spending digest: when it's due, how to aggregate a
// day's expenses, and how to format the message. Kept free of I/O (no DB, no
// provider, no bot) so it can be unit-tested directly; the orchestration lives
// in ./daily.ts.

import type { ExpenseRecord } from '../core/types.js';
import { formatMoney } from '../util/money.js';
import { previousDateStr, zonedDayRange, zonedParts } from '../util/day.js';

export interface DailyReportWindow {
  /** Local calendar date (YYYY-MM-DD) the digest reports on. */
  reportDate: string;
  fromMs: number;
  toMs: number;
}

/** The "yesterday" window to report on at instant `nowMs`, in timezone `tz`. */
export function yesterdayWindow(nowMs: number, tz: string): DailyReportWindow {
  const today = zonedParts(nowMs, tz).dateStr;
  const reportDate = previousDateStr(today);
  const { fromMs, toMs } = zonedDayRange(reportDate, tz);
  return { reportDate, fromMs, toMs };
}

export interface DueDecision {
  send: boolean;
  window: DailyReportWindow;
}

/**
 * Decide whether the previous day's digest is due to post right now for a chat
 * whose digest is scheduled at `hour:minute` local time and last posted
 * `lastDate`. Fires once the local time has reached the target and that report
 * date hasn't been posted yet (so a bot that was down at the exact minute still
 * catches up later the same day).
 */
export function decideDue(
  nowMs: number,
  tz: string,
  s: { hour: number; minute: number; lastDate: string | null },
): DueDecision {
  const window = yesterdayWindow(nowMs, tz);
  const now = zonedParts(nowMs, tz);
  const nowMinutes = now.hour * 60 + now.minute;
  const targetMinutes = s.hour * 60 + s.minute;
  const send = nowMinutes >= targetMinutes && s.lastDate !== window.reportDate;
  return { send, window };
}

export interface PayerTotal {
  memberId: string;
  /** currency -> minor units fronted. */
  totals: Record<string, number>;
}

export interface DailyAggregate {
  count: number;
  /** currency -> total minor units spent. */
  totals: Record<string, number>;
  /** Payers ordered by how much they fronted (descending). */
  payers: PayerTotal[];
  top?: { title: string; amountMinor: number; currency: string };
}

function sumValues(rec: Record<string, number>): number {
  return Object.values(rec).reduce((a, b) => a + b, 0);
}

/** Roll a day's expenses up into totals, per-payer totals, and the top expense. */
export function aggregate(records: ExpenseRecord[]): DailyAggregate {
  const totals: Record<string, number> = {};
  const payerMap = new Map<string, Record<string, number>>();
  let top: DailyAggregate['top'];

  for (const r of records) {
    totals[r.currency] = (totals[r.currency] ?? 0) + r.amountMinor;
    for (const [id, amt] of Object.entries(r.payerAmounts)) {
      if (amt <= 0) continue;
      const t = payerMap.get(id) ?? {};
      t[r.currency] = (t[r.currency] ?? 0) + amt;
      payerMap.set(id, t);
    }
    if (!top || r.amountMinor > top.amountMinor) {
      top = {
        title: r.title?.trim() || 'без названия',
        amountMinor: r.amountMinor,
        currency: r.currency,
      };
    }
  }

  const payers = [...payerMap.entries()]
    .map(([memberId, t]) => ({ memberId, totals: t }))
    .sort((a, b) => sumValues(b.totals) - sumValues(a.totals));

  return { count: records.length, totals, payers, top };
}

function ruPlural(n: number, forms: [string, string, string]): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return forms[1];
  return forms[2];
}

/** Join a currency->minor map into "12.00 EUR · 3000 JPY". */
function formatTotals(totals: Record<string, number>): string {
  return Object.entries(totals)
    .map(([currency, minor]) => formatMoney(minor, currency))
    .join(' · ');
}

/**
 * Render the digest message (plain text / light Markdown). When the day had no
 * expenses, returns a short "nothing spent" note — the humorizer turns that into
 * a quip. Names map provider member ids to display names.
 */
export function formatDailyReport(
  agg: DailyAggregate,
  names: Map<string, string>,
  opts: { humanDate: string },
): string {
  if (agg.count === 0) {
    return `За ${opts.humanDate} никто ничего не потратил — кошельки целы.`;
  }

  const lines: string[] = [];
  lines.push(`💸 Траты за ${opts.humanDate}`);
  const tratPlural = ruPlural(agg.count, ['трата', 'траты', 'трат']);
  lines.push(`Всего: ${formatTotals(agg.totals)} (${agg.count} ${tratPlural})`);

  if (agg.payers.length > 0) {
    lines.push('Платили:');
    for (const p of agg.payers) {
      const name = names.get(p.memberId) ?? 'кто-то';
      lines.push(`• ${name} — ${formatTotals(p.totals)}`);
    }
  }

  if (agg.top) {
    lines.push(
      `Крупнейшая: «${agg.top.title}» — ${formatMoney(agg.top.amountMinor, agg.top.currency)}`,
    );
  }

  return lines.join('\n');
}
