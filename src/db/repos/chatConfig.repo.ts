import { getDb } from '../client.js';

export interface ChatConfigRow {
  chat_id: number;
  provider_name: string;
  credential: string | null;
  provider_group_id: string | null;
  default_currency: string;
  created_by: number | null;
  created_at: number;
}

export function getChatConfig(chatId: number): ChatConfigRow | undefined {
  return getDb()
    .prepare('SELECT * FROM chat_config WHERE chat_id = ?')
    .get(chatId) as ChatConfigRow | undefined;
}

export function upsertChatConfig(args: {
  chatId: number;
  providerName: string;
  credential: string;
  providerGroupId: string;
  defaultCurrency: string;
  createdBy: number;
}): void {
  getDb()
    .prepare(
      `INSERT INTO chat_config
         (chat_id, provider_name, credential, provider_group_id, default_currency, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, unixepoch() * 1000)
       ON CONFLICT(chat_id) DO UPDATE SET
         provider_name = excluded.provider_name,
         credential = excluded.credential,
         provider_group_id = excluded.provider_group_id,
         default_currency = excluded.default_currency`,
    )
    .run(
      args.chatId,
      args.providerName,
      args.credential,
      args.providerGroupId,
      args.defaultCurrency,
      args.createdBy,
    );
}

export function setDefaultCurrency(chatId: number, currency: string): void {
  getDb()
    .prepare('UPDATE chat_config SET default_currency = ? WHERE chat_id = ?')
    .run(currency.toUpperCase(), chatId);
}
