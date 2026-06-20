import { getDb } from '../client.js';
import { normalizeName } from '../../util/ids.js';

/** Learned aliases for a chat: normalized alias → member id. */
export function getAliasMap(chatId: number): Map<string, string> {
  const rows = getDb()
    .prepare('SELECT alias, member_id FROM name_alias WHERE chat_id = ?')
    .all(chatId) as { alias: string; member_id: string }[];
  return new Map(rows.map((r) => [r.alias, r.member_id]));
}

export function setAlias(
  chatId: number,
  alias: string,
  memberId: string,
  memberName: string,
): void {
  getDb()
    .prepare(
      `INSERT INTO name_alias (chat_id, alias, member_id, member_name, created_at)
       VALUES (?, ?, ?, ?, unixepoch() * 1000)
       ON CONFLICT(chat_id, alias) DO UPDATE SET
         member_id = excluded.member_id,
         member_name = excluded.member_name`,
    )
    .run(chatId, normalizeName(alias), memberId, memberName);
}
