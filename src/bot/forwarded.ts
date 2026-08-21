import type { Message } from 'grammy/types';
import { loadConfig } from '../config.js';

/**
 * Forwarded vs. written-here. Telegram marks a forwarded message with
 * `forward_origin` (Bot API 7.0+); older payloads used the `forward_from*`
 * fields, which are still read here so nothing depends on the API version the
 * bot happens to be talking to.
 *
 * This matters for two things:
 *  - the model must know the text was written by SOMEONE ELSE somewhere else, so
 *    it doesn't attribute it to the sender (and so a chat RULE can key on it —
 *    «ничего не запоминай из пересланных»);
 *  - passive learning (lexicon + memory) reads forwarded text as if the chat had
 *    said it, which is how a forwarded article's facts and a forwarded meme's
 *    words end up in a chat's memory/lexicon. That one can't be fixed by a rule
 *    (those passes never see the rules), so it is gated deterministically below.
 */

/** The message as Telegram may deliver it, incl. the legacy forward fields. */
type ForwardableMessage = Partial<Message> & {
  forward_from?: { first_name?: string; last_name?: string; username?: string };
  forward_from_chat?: { title?: string; username?: string };
  forward_sender_name?: string;
  forward_date?: number;
};

export function isForwarded(msg: ForwardableMessage | undefined): boolean {
  if (!msg) return false;
  return (
    msg.forward_origin != null ||
    msg.forward_from != null ||
    msg.forward_from_chat != null ||
    msg.forward_sender_name != null ||
    msg.forward_date != null
  );
}

/**
 * Who the forwarded message came from, as a short human label for the model
 * («Вася Пупкин», «канал «Дуров пишет»», «скрытый отправитель»). Null when the
 * message wasn't forwarded; a bare "источник неизвестен" when it was forwarded
 * but Telegram gave us nothing to name (privacy settings).
 */
export function forwardOrigin(msg: ForwardableMessage | undefined): string | null {
  if (!isForwarded(msg)) return null;
  const origin = msg!.forward_origin;

  if (origin) {
    switch (origin.type) {
      case 'user':
        return personName(origin.sender_user) ?? 'источник неизвестен';
      case 'hidden_user':
        return origin.sender_user_name || 'скрытый отправитель';
      case 'chat':
        return chatName(origin.sender_chat, 'чат');
      case 'channel':
        return chatName(origin.chat, 'канал');
    }
  }

  // Legacy fields (pre-Bot-API-7 payloads).
  if (msg!.forward_from) return personName(msg!.forward_from) ?? 'источник неизвестен';
  if (msg!.forward_from_chat) return chatName(msg!.forward_from_chat, 'канал');
  if (msg!.forward_sender_name) return msg!.forward_sender_name;
  return 'источник неизвестен';
}

function personName(user?: {
  first_name?: string;
  last_name?: string;
  username?: string;
}): string | null {
  if (!user) return null;
  const full = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  if (full) return full;
  return user.username ? `@${user.username}` : null;
}

function chatName(chat: { title?: string; username?: string } | undefined, kind: string): string {
  if (!chat) return `${kind} (без названия)`;
  if (chat.title) return `${kind} «${chat.title}»`;
  return chat.username ? `${kind} @${chat.username}` : `${kind} (без названия)`;
}

/**
 * Whether passive learning (the lexicon and memory extractors) may read this
 * message. A forwarded message is someone else's words about someone else's
 * life: learning slang from it makes the bot speak a stranger's voice, and
 * learning facts from it fills the chat's memory with things nobody here said.
 * Off for forwards by default; `LEARN_FROM_FORWARDS=true` brings the old
 * behaviour back for chats that want it.
 *
 * This is deliberately deterministic rather than rule-driven: the extractors run
 * as their own cheap batched passes and never see the chat's rules, so a rule
 * like «не запоминай из пересланных» could not reach them.
 */
export function passiveLearningAllowed(msg: ForwardableMessage | undefined): boolean {
  return !isForwarded(msg) || loadConfig().LEARN_FROM_FORWARDS;
}
