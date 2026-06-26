// Pure logic for the spending skill: resolving a date range, aggregating a
// period's expenses, and formatting the spending + balances messages. Kept free
// of I/O (no DB, provider, or bot) so it can be unit-tested directly; the
// orchestration (provider calls, humorizer, wiring) lives in ./handler.ts.

import type {
  BalanceSummary,
  DateRange,
  ExpenseRecord,
} from '../core/types.js';
import { formatMoney } from '../util/money.js';
import { previousDateStr, startOfZonedDayMs, zonedDayRange, zonedParts } from '../util/day.js';

export interface SpendingRangeInput {
  /** Inclusive start day (YYYY-MM-DD, chat-local), or null. */
  fromDate: string | null;
  /** Inclusive end day (YYYY-MM-DD, chat-local), or null. */
  toDate: string | null;
}

export interface ResolvedSpending {
  range: DateRange;
  fromDate: string;
  toDate: string;
  /** Human label for the period header, e.g. "24 июня" or "22–24 июня". */
  label: string;
}

/** Format one local calendar day as "24 июня" in the given timezone. */
function humanDay(dateStr: string, tz: string): string {
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
 * Resolve a (possibly partial) date range into a concrete UTC window plus a
 * human label. Missing dates default to "yesterday" (relative to `nowMs` in
 * `tz`); a single date means just that day; two dates are an inclusive span.
 */
export function resolveSpending(
  input: SpendingRangeInput,
  tz: string,
  nowMs: number,
): ResolvedSpending {
  let fromDate = input.fromDate;
  let toDate = input.toDate;
  if (!fromDate && !toDate) {
    const today = zonedParts(nowMs, tz).dateStr;
    fromDate = toDate = previousDateStr(today);
  } else {
    fromDate = fromDate ?? toDate!;
    toDate = toDate ?? fromDate;
  }
  // Normalise reversed inputs so a swapped from/to still yields a valid window.
  if (fromDate > toDate) [fromDate, toDate] = [toDate, fromDate];

  const fromMs = zonedDayRange(fromDate, tz).fromMs;
  const toMs = zonedDayRange(toDate, tz).toMs;
  const label =
    fromDate === toDate
      ? humanDay(fromDate, tz)
      : `${humanDay(fromDate, tz)} — ${humanDay(toDate, tz)}`;
  return { range: { fromMs, toMs }, fromDate, toDate, label };
}

function normalizeTerm(s: string): string {
  return s.toLowerCase().trim();
}

/**
 * Approximate category filter: keep expenses whose title or category mentions
 * any of `keywords` (case-insensitive substring match). The model supplies a
 * generous keyword set (both languages + provider category names), so "на еду"
 * catches restaurants, groceries, cafes, etc. An empty keyword list is a no-op.
 */
export function filterByKeywords(
  records: ExpenseRecord[],
  keywords: string[],
): ExpenseRecord[] {
  const terms = keywords.map(normalizeTerm).filter(Boolean);
  if (terms.length === 0) return records;
  return records.filter((r) => {
    const hay = normalizeTerm(
      `${r.title ?? ''} ${r.category ?? ''} ${r.categoryKey ?? ''}`,
    );
    return terms.some((t) => hay.includes(t));
  });
}

export interface PayerTotal {
  memberId: string;
  /** currency -> minor units fronted. */
  totals: Record<string, number>;
}

export interface SpendingAggregate {
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

/** Roll a period's expenses up into totals, per-payer totals, and the top expense. */
export function aggregate(records: ExpenseRecord[]): SpendingAggregate {
  const totals: Record<string, number> = {};
  const payerMap = new Map<string, Record<string, number>>();
  let top: SpendingAggregate['top'];

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
 * Render the spending section (plain text / light Markdown). When the period had
 * no expenses, returns a short "nothing spent" note for the humorizer to riff on.
 * `names` maps provider member ids to display names.
 */
export function formatSpendingReport(
  agg: SpendingAggregate,
  names: Map<string, string>,
  opts: { periodLabel: string },
): string {
  if (agg.count === 0) {
    return `За ${opts.periodLabel} никто ничего не потратил — кошельки целы.`;
  }

  const lines: string[] = [];
  lines.push(`💸 Траты за ${opts.periodLabel}`);
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

/** Render the who-owes-whom section from a provider balance snapshot. */
export function formatBalances(
  summary: BalanceSummary,
  names: Map<string, string>,
): string {
  const name = (id: string): string => names.get(id) ?? 'кто-то';
  if (summary.settlements.length === 0) {
    return 'Все в расчёте — никто никому не должен 🎉';
  }
  const lines = ['💰 Кто кому должен:'];
  for (const s of summary.settlements) {
    lines.push(
      `• ${name(s.fromId)} → ${name(s.toId)}: ${formatMoney(s.amountMinor, summary.currency)}`,
    );
  }
  return lines.join('\n');
}
