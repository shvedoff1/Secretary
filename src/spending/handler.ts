import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { getProvider } from '../core/registry.js';
import { getChatConfig } from '../db/repos/chatConfig.repo.js';
import {
  getTimezone,
  getChatMode,
  getPersonaPrompt,
  isChatHumorEnabled,
} from '../db/repos/chatSettings.repo.js';
import { getVoiceLexicon } from '../db/repos/lexicon.repo.js';
import { modeAllowsHumor, modeAllowsSlang } from '../modes.js';
import { humorizeOrOriginal, humorPersonaForMode } from '../llm/humorize.js';
import { applySlangOrOriginal } from '../llm/slang.js';
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

      // Money digests are the one place we deliberately humorize; give the pass
      // the chat's slang too so the tone matches (facts stay locked by the
      // humorizer's hard rules).
      const plain = sections.join('\n\n');
      // The digest is `toned: true` for the caller either way — it owns its tone
      // pass here, because the figures must ship verbatim and re-toning already
      // toned text would risk them twice.
      const mode = getChatMode(chatId);
      const lexicon = modeAllowsSlang(mode)
        ? getVoiceLexicon(chatId, cfg.LEXICON_MAX_TERMS)
        : [];
      // Humor off for this chat — or a mode that never jokes (the calm assistant):
      // no jokes over money, but the chat's WORDS still apply, so the digest gets
      // the fact-guarded slang pass instead of the full rewrite. Slang off as well
      // → exact plain text.
      if (!modeAllowsHumor(mode) || !isChatHumorEnabled(chatId)) {
        return applySlangOrOriginal(plain, lexicon);
      }
      return humorizeOrOriginal(
        plain,
        lexicon,
        // The digest speaks the chat's persona (dota → schoolkid-sensei rewrite,
        // custom → the admin's described character).
        humorPersonaForMode(mode, mode === 'custom' ? getPersonaPrompt(chatId) : null),
      );
    } catch (err) {
      logger.error({ err, chatId }, 'spending_report failed');
      return 'Не удалось собрать отчёт — Splid не ответил. Попробуйте чуть позже.';
    }
  };
}
