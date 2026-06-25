import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { getProvider } from '../core/registry.js';
import { getChatConfig } from '../db/repos/chatConfig.repo.js';
import { getTimezone } from '../db/repos/chatSettings.repo.js';
import { humorizeOrOriginal } from '../llm/humorize.js';
import type { SpendingReportInput } from '../llm/schema.js';
import {
  aggregate,
  filterByKeywords,
  formatBalances,
  formatSpendingReport,
  resolveSpending,
} from './report.js';

/**
 * Build the `spending_report` tool handler for a chat. Stateless beyond the
 * chatId — the same shape is shared by the live chat flow and the scheduler, so
 * a recurring "сводка трат в 9 утра" task produces the digest the same way an
 * on-demand "скинь траты за 3 дня" does.
 *
 * The report is built deterministically from the provider (Splid) — reading the
 * source of truth, so expenses added directly in the Splid app count too — and
 * then run through the humorizer (the one place we deliberately humorize money,
 * which is the whole point of the feature). Falls back to plain text when the
 * humorizer is disabled or fails.
 */
export function makeSpendingReportHandler(
  chatId: number,
): (input: SpendingReportInput) => Promise<string> {
  return async (input) => {
    const cfg = loadConfig();
    const cc = getChatConfig(chatId);
    if (!cc?.provider_group_id) {
      return 'Группа Splid не подключена — нечего считать. Подключите: /group <код>.';
    }
    const tz = getTimezone(chatId) ?? input.timezone ?? cfg.DEFAULT_TIMEZONE;
    const provider = getProvider(cc.provider_name);
    const conn = { groupId: cc.provider_group_id };

    // A pure balances request ("сколько кто кому должен") carries no dates and
    // balances=true — skip the spending section in that case.
    const wantSpending = !!(input.fromDate || input.toDate) || !input.balances;

    try {
      const members = await provider.listMembers(conn);
      const names = new Map(members.map((m) => [m.id, m.name]));
      const sections: string[] = [];

      if (wantSpending) {
        const resolved = resolveSpending(input, tz, Date.now());
        const all = await provider.listExpenses(conn, resolved.range);
        const records = filterByKeywords(all, input.filterKeywords ?? []);
        // Append the category to the period header, e.g. "24 июня на «еду»".
        const periodLabel = input.filterLabel
          ? `${resolved.label} на «${input.filterLabel}»`
          : resolved.label;
        sections.push(
          formatSpendingReport(aggregate(records), names, { periodLabel }),
        );
      }

      if (input.balances) {
        const summary = await provider.getBalances(conn);
        sections.push(formatBalances(summary, names));
      }

      return humorizeOrOriginal(sections.join('\n\n'));
    } catch (err) {
      logger.error({ err, chatId }, 'spending_report failed');
      return 'Не удалось собрать отчёт — Splid не ответил. Попробуйте чуть позже.';
    }
  };
}
