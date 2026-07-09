import type { Context } from 'grammy';
import type { ReactionTypeEmoji } from '@grammyjs/types';
import { logger } from '../logger.js';

// Light chat seasoning: a small fraction of messages get a random positive
// reaction. No LLM, no memory, no per-user rules.
const REACT_PROBABILITY = 0.1;

// Positive subset of Telegram's allowed reaction emojis. `satisfies` makes the
// build fail if any entry isn't a real Telegram reaction (typos, stray
// variation selectors), so the allowed set is validated at compile time.
export const POSITIVE_REACTIONS = [
  '👍', '❤', '🔥', '🥰', '👏', '😁', '🎉', '🤩', '🙏', '👌', '😍', '💯',
  '🤣', '⚡', '🏆', '🍓', '🍾', '💋', '🤝', '🤗', '🫡', '🆒', '💘', '🦄',
  '😘', '😎',
] as const satisfies readonly ReactionTypeEmoji['emoji'][];

/**
 * With ~10% probability, drop a random positive reaction on the incoming
 * message. Best-effort: skips slash-commands, and a failed reaction (disabled in
 * chat, missing rights) is logged but never throws — the middleware chain must
 * continue.
 */
/**
 * Set (or clear, with `[]`) a message reaction, swallowing failures. Reactions
 * are best-effort — disabled in the chat, missing rights, an already-gone message
 * — and must never break the surrounding flow. Shared by the "thinking"/"writing"
 * progress markers (assist/voice flows) and the auto-react.
 */
export async function safeReact(
  ctx: Context,
  reaction: Parameters<Context['react']>[0],
): Promise<void> {
  try {
    await ctx.react(reaction);
  } catch (err) {
    logger.debug({ err }, 'reaction failed (best-effort)');
  }
}

export async function maybeAutoReact(ctx: Context): Promise<void> {
  // Don't react to commands like /help — only real chat messages.
  if (ctx.message?.text?.startsWith('/')) return;
  if (Math.random() >= REACT_PROBABILITY) return;
  const emoji = POSITIVE_REACTIONS[Math.floor(Math.random() * POSITIVE_REACTIONS.length)];
  if (!emoji) return;
  await safeReact(ctx, emoji);
}
