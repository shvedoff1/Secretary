import type { Context } from 'grammy';
import { logger } from '../logger.js';

// Deterministic auto-reactions: drop an emoji reaction on specific users'
// messages. Keyed by Telegram user id so it survives name/username changes —
// no LLM, no memory, no cost. Add more entries as needed.
const AUTO_REACTIONS = new Map<number, '🔥'>([
  [68059142, '🔥'], // Антоха
]);

/**
 * React to the incoming message if its sender is in AUTO_REACTIONS. Best-effort:
 * skips slash-commands, and a failed reaction (disabled in chat, missing rights)
 * is logged but never throws — the middleware chain must continue.
 */
export async function maybeAutoReact(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (userId === undefined) return;
  // Don't react to commands like /help — only real messages.
  if (ctx.message?.text?.startsWith('/')) return;
  const emoji = AUTO_REACTIONS.get(userId);
  if (!emoji) return;
  try {
    await ctx.react(emoji);
  } catch (err) {
    logger.debug({ err, userId }, 'auto-react failed');
  }
}
