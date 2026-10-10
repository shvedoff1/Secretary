// Forum topics («треды») and links back to messages.
//
// A forum supergroup posts every message into a topic; Telegram marks it with
// `is_topic_message` + `message_thread_id` (the General topic carries neither).
// The chat log stores that thread id so a recap can be scoped to one topic, and
// the message id so a recap / bug candidate can link to its source. Pure helpers
// up top (unit-tested), the one DB-touching learner below.

import type { Message } from 'grammy/types';
import { upsertTopic } from '../db/repos/topic.repo.js';
import { logger } from '../logger.js';

export { messageLink } from '../util/telegramLink.js';

type MsgLike = Pick<Message, 'message_id'> &
  Partial<
    Pick<
      Message,
      'is_topic_message' | 'message_thread_id' | 'forum_topic_created' | 'forum_topic_edited'
    >
  > & { reply_to_message?: Partial<Pick<Message, 'forum_topic_created'>> };

/** The forum topic a message was posted in; null outside forums and in General. */
export function threadIdOf(msg: Partial<MsgLike> | undefined | null): number | null {
  if (!msg?.is_topic_message || msg.message_thread_id == null) return null;
  return msg.message_thread_id;
}

/** The `{threadId, messageId}` pair every chat-log line of an incoming message carries. */
export function logRefs(msg: Partial<MsgLike> | undefined | null): {
  threadId: number | null;
  messageId: number | null;
} {
  return { threadId: threadIdOf(msg), messageId: msg?.message_id ?? null };
}

/**
 * What a message reveals about topic NAMES, if anything. Telegram has no "list
 * topics" call for bots, so names are learned from: the creation service message,
 * a rename, and — the one that covers topics created before the bot joined — the
 * topic-root reference a message in a topic carries as `reply_to_message` when it
 * isn't an explicit reply to something else.
 */
export function topicNameFrom(msg: MsgLike): { threadId: number; name: string } | null {
  const thread = msg.message_thread_id;
  if (msg.forum_topic_created?.name && thread != null) {
    return { threadId: thread, name: msg.forum_topic_created.name };
  }
  if (msg.forum_topic_edited?.name && thread != null) {
    return { threadId: thread, name: msg.forum_topic_edited.name };
  }
  const root = msg.reply_to_message?.forum_topic_created;
  if (root?.name && msg.is_topic_message && thread != null) {
    return { threadId: thread, name: root.name };
  }
  return null;
}

/** Remember a topic name the message reveals. Best-effort, never throws. */
export function learnTopicName(chatId: number, msg: MsgLike | undefined): void {
  if (!msg) return;
  try {
    const found = topicNameFrom(msg);
    if (found) upsertTopic(chatId, found.threadId, found.name);
  } catch (err) {
    logger.warn({ err, chatId }, 'topic name learn failed');
  }
}
