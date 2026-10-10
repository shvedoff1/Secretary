import { getDb } from '../client.js';

// Forum topic names («треды»). Telegram never hands a bot the list of a forum's
// topics, so names are LEARNED as they go by: the service messages for a topic
// being created / renamed, and the topic-root reference every message in a topic
// carries (see src/bot/threads.ts). A topic nobody has posted in since the bot
// joined is simply unknown — it is still reachable by its numeric id.

export interface ChatTopic {
  threadId: number;
  name: string;
}

export function upsertTopic(chatId: number, threadId: number, name: string): void {
  const clean = name.trim();
  if (!clean || threadId <= 0) return;
  getDb()
    .prepare(
      `INSERT INTO chat_topic (chat_id, thread_id, name, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(chat_id, thread_id) DO UPDATE SET
         name = excluded.name, updated_at = excluded.updated_at
       WHERE chat_topic.name <> excluded.name`,
    )
    .run(chatId, threadId, clean, Date.now());
}

export function listTopics(chatId: number): ChatTopic[] {
  return (
    getDb()
      .prepare('SELECT thread_id, name FROM chat_topic WHERE chat_id = ? ORDER BY name COLLATE NOCASE')
      .all(chatId) as { thread_id: number; name: string }[]
  ).map((r) => ({ threadId: r.thread_id, name: r.name }));
}

export function topicName(chatId: number, threadId: number): string | null {
  const row = getDb()
    .prepare('SELECT name FROM chat_topic WHERE chat_id = ? AND thread_id = ?')
    .get(chatId, threadId) as { name: string } | undefined;
  return row?.name ?? null;
}
