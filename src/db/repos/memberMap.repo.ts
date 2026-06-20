import { getDb } from '../client.js';

export interface MemberMapRow {
  chat_id: number;
  tg_user_id: number;
  provider_member_id: string;
  member_name: string;
}

export function getMapping(
  chatId: number,
  tgUserId: number,
): MemberMapRow | undefined {
  return getDb()
    .prepare('SELECT * FROM member_map WHERE chat_id = ? AND tg_user_id = ?')
    .get(chatId, tgUserId) as MemberMapRow | undefined;
}

export function listMappings(chatId: number): MemberMapRow[] {
  return getDb()
    .prepare('SELECT * FROM member_map WHERE chat_id = ?')
    .all(chatId) as MemberMapRow[];
}

export function upsertMapping(args: {
  chatId: number;
  tgUserId: number;
  providerMemberId: string;
  memberName: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO member_map (chat_id, tg_user_id, provider_member_id, member_name)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(chat_id, tg_user_id) DO UPDATE SET
         provider_member_id = excluded.provider_member_id,
         member_name = excluded.member_name`,
    )
    .run(args.chatId, args.tgUserId, args.providerMemberId, args.memberName);
}

export function deleteMapping(chatId: number, tgUserId: number): void {
  getDb()
    .prepare('DELETE FROM member_map WHERE chat_id = ? AND tg_user_id = ?')
    .run(chatId, tgUserId);
}
