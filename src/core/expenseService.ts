import type { ParsedExpense, ExpenseDraft, Member, Split } from './types.js';
import { normalizeName } from '../util/ids.js';
import { sameGivenName } from './nameAliases.js';

const ME_HINTS = new Set(['me', 'я', 'i', 'myself', 'мне', 'меня']);
const ALL_HINTS = new Set([
  'all',
  'everyone',
  'все',
  'всех',
  'всем',
  'everybody',
]);

function resolveHint(
  hint: string,
  members: Member[],
  senderMemberId: string | null,
  aliases?: Map<string, string>,
): string | null {
  const n = normalizeName(hint);
  if (ME_HINTS.has(n)) return senderMemberId;

  // chat-specific learned aliases win (the user taught these explicitly)
  if (aliases) {
    const id = aliases.get(n);
    if (id && members.some((m) => m.id === id)) return id;
  }

  // exact name
  const exact = members.find((m) => normalizeName(m.name) === n);
  if (exact) return exact.id;

  // exact initials
  const byInitials = members.find(
    (m) => m.initials && normalizeName(m.initials) === n,
  );
  if (byInitials) return byInitials.id;

  // startsWith / contains (first-name match etc.)
  const partial = members.filter(
    (m) => normalizeName(m.name).includes(n) || n.includes(normalizeName(m.name)),
  );
  if (partial.length === 1) return partial[0]!.id;

  // Russian diminutive dictionary (Миха → Михаил, Тоха → Антон, …)
  const byAlias = members.filter((m) => sameGivenName(n, m.name));
  if (byAlias.length === 1) return byAlias[0]!.id;

  return null;
}

/**
 * Turn a model-parsed expense into a fully-resolved draft against the group's
 * member roster. Any hint that can't be mapped lands in `unresolved`, which
 * blocks submission.
 */
export function buildDraft(args: {
  parsed: ParsedExpense;
  members: Member[];
  senderMemberId: string | null;
  defaultCurrency: string;
  /** Chat-specific learned aliases: normalized alias → member id. */
  aliases?: Map<string, string>;
}): ExpenseDraft {
  const { parsed, members, senderMemberId, defaultCurrency, aliases } = args;
  const currency = (parsed.currency || defaultCurrency).toUpperCase();
  const unresolved: string[] = [];

  // --- Payers ---
  let payers: Split[];
  if (parsed.payerHints.length === 0) {
    if (senderMemberId) {
      payers = [{ memberId: senderMemberId }];
    } else {
      payers = [];
      unresolved.push('(плательщик: вы не привязаны — /link)');
    }
  } else {
    payers = [];
    for (const hint of parsed.payerHints) {
      const id = resolveHint(hint, members, senderMemberId, aliases);
      if (id) payers.push({ memberId: id });
      else unresolved.push(hint);
    }
  }

  // --- Profiteers ---
  const everyone = (): Split[] => members.map((m) => ({ memberId: m.id }));
  let profiteers: Split[];

  if (parsed.splits && parsed.splits.length > 0) {
    profiteers = [];
    for (const s of parsed.splits) {
      const id = resolveHint(s.memberHint, members, senderMemberId, aliases);
      if (!id) {
        unresolved.push(s.memberHint);
        continue;
      }
      const split: Split = { memberId: id };
      if (s.amountMinor != null) split.amount = s.amountMinor;
      else if (s.share != null) split.share = s.share;
      profiteers.push(split);
    }
  } else if (
    parsed.profiteerHints.length === 0 ||
    parsed.profiteerHints.some((h) => ALL_HINTS.has(normalizeName(h)))
  ) {
    profiteers = everyone();
  } else {
    profiteers = [];
    for (const hint of parsed.profiteerHints) {
      if (ALL_HINTS.has(normalizeName(hint))) {
        profiteers = everyone();
        break;
      }
      const id = resolveHint(hint, members, senderMemberId, aliases);
      if (id) profiteers.push({ memberId: id });
      else unresolved.push(hint);
    }
  }

  if (profiteers.length === 0 && unresolved.length === 0) {
    profiteers = everyone();
  }

  return {
    title: parsed.title,
    amountMinor: parsed.amountMinor,
    currency,
    payers,
    profiteers,
    unresolved,
    confidence: parsed.confidence,
    notes: parsed.notes ?? null,
  };
}
