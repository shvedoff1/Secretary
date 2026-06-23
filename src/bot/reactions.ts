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
export async function maybeAutoReact(ctx: Context): Promise<void> {
  // Don't react to commands like /help — only real chat messages.
  if (ctx.message?.text?.startsWith('/')) return;
  if (Math.random() >= REACT_PROBABILITY) return;
  const emoji = POSITIVE_REACTIONS[Math.floor(Math.random() * POSITIVE_REACTIONS.length)];
  if (!emoji) return;
  try {
    await ctx.react(emoji);
  } catch (err) {
    logger.debug({ err }, 'auto-react failed');
  }
}
