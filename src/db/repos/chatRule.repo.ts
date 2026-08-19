import { getDb } from '../client.js';

/**
 * A standing behaviour instruction for one chat, in the user's own words
 * («все голосовые очищай от слов-паразитов и скидывай расшифровку»).
 *
 * Rules are NOT memory: memory holds facts the bot knows, a rule is an order it
 * follows. They are injected into every turn's context block as directives, so
 * the list is deliberately small and curated (see `CHAT_RULES_MAX`) — unlike the
 * memory store, which is deep and reached on demand.
 */
export interface ChatRule {
  id: number;
  text: string;
  tgUserId: number | null;
  createdAt: number;
}

function rowToRule(row: {
  id: number;
  text: string;
  tg_user_id: number | null;
  created_at: number;
}): ChatRule {
  return {
    id: row.id,
    text: row.text,
    tgUserId: row.tg_user_id,
    createdAt: row.created_at,
  };
}

/** Rules of a chat, oldest first — the order they are shown and numbered in. */
export function listRules(chatId: number): ChatRule[] {
  const rows = getDb()
    .prepare(
      `SELECT id, text, tg_user_id, created_at FROM chat_rule
        WHERE chat_id = ? ORDER BY id`,
    )
    .all(chatId) as Parameters<typeof rowToRule>[0][];
  return rows.map(rowToRule);
}

export function countRules(chatId: number): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM chat_rule WHERE chat_id = ?')
    .get(chatId) as { n: number };
  return row.n;
}

export type AddRuleResult =
  | { status: 'added'; rule: ChatRule }
  | { status: 'duplicate'; rule: ChatRule }
  | { status: 'full'; max: number };

/**
 * Add a rule. Adding the SAME rule twice is a no-op (the model re-confirming an
 * existing standing instruction must not double it in the context block), and the
 * per-chat cap is enforced here rather than at the call sites so both the command
 * and the `set_rule` tool are bounded by it.
 */
export function addRule(args: {
  chatId: number;
  text: string;
  tgUserId?: number | null;
  max: number;
}): AddRuleResult {
  const text = args.text.trim();
  const existing = findRule(args.chatId, text);
  if (existing) return { status: 'duplicate', rule: existing };
  if (countRules(args.chatId) >= args.max) return { status: 'full', max: args.max };

  const info = getDb()
    .prepare(
      `INSERT INTO chat_rule (chat_id, text, tg_user_id, created_at)
       VALUES (?, ?, ?, unixepoch() * 1000)`,
    )
    .run(args.chatId, text, args.tgUserId ?? null);
  const id = Number(info.lastInsertRowid);
  const row = getDb()
    .prepare('SELECT id, text, tg_user_id, created_at FROM chat_rule WHERE id = ?')
    .get(id) as Parameters<typeof rowToRule>[0];
  return { status: 'added', rule: rowToRule(row) };
}

/** Delete by id (the number shown in /rules). Returns the removed text, or null. */
export function removeRule(chatId: number, id: number): string | null {
  const row = getDb()
    .prepare('SELECT text FROM chat_rule WHERE chat_id = ? AND id = ?')
    .get(chatId, id) as { text: string } | undefined;
  if (!row) return null;
  getDb().prepare('DELETE FROM chat_rule WHERE chat_id = ? AND id = ?').run(chatId, id);
  return row.text;
}

export function clearRules(chatId: number): number {
  const info = getDb().prepare('DELETE FROM chat_rule WHERE chat_id = ?').run(chatId);
  return info.changes;
}

/**
 * Find a rule by its text, forgivingly — the model quotes a rule back in its own
 * words when cancelling one («убери правило про голосовые»), so an exact match is
 * rarely what arrives. Same ladder as the lexicon/memory lookups: exact
 * (case/space-insensitive) first, then UNIQUE containment either way. Ambiguous
 * (several candidates) resolves to null — better to ask than to drop the wrong rule.
 */
export function findRule(chatId: number, text: string): ChatRule | null {
  const needle = normalize(text);
  if (!needle) return null;
  const rules = listRules(chatId);

  const exact = rules.filter((r) => normalize(r.text) === needle);
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) return exact[0]!; // identical texts: any of them is right

  const contains = rules.filter((r) => {
    const hay = normalize(r.text);
    return hay.includes(needle) || needle.includes(hay);
  });
  return contains.length === 1 ? contains[0]! : null;
}

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/[«»"'`.,!?;:()]/g, '').replace(/\s+/g, ' ');
}
