import type { Context } from 'grammy';

/** Telegram rejects a sendMessage whose text exceeds 4096 UTF-16 code units. */
export const TELEGRAM_MAX_MESSAGE = 4096;

/**
 * Split a plain-text message into Telegram-sized chunks. Prefers to break on
 * newlines (and, failing that, spaces) so a chunk boundary doesn't land in the
 * middle of a line; a single line longer than the limit is hard-split. Returns
 * at least one chunk (possibly empty) so callers can always send something.
 *
 * Why this exists: a few commands dump an open-ended inventory (the full learned
 * lexicon, a chat's whole memory). As that grows past 4096 chars a single reply
 * would 400 from Telegram and — because the error is swallowed by `bot.catch` —
 * the command looks like it silently does nothing. Chunking keeps those replies
 * working no matter how much the underlying data grows.
 */
export function splitTelegramMessage(text: string, limit = TELEGRAM_MAX_MESSAGE): string[] {
  if (limit <= 0) throw new Error('limit must be positive');
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    // Prefer the last newline, then the last space, so we cut on a natural
    // boundary; if there's neither, hard-cut at the limit.
    let cut = window.lastIndexOf('\n');
    if (cut < limit * 0.5) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = limit;
    chunks.push(rest.slice(0, cut).replace(/\s+$/, ''));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

/**
 * Reply with `text`, transparently splitting it across several messages when it
 * exceeds Telegram's per-message limit. Plain text by default; pass
 * `{ html: true }` for parse_mode HTML (the caller must escape dynamic content —
 * commands wrapped in <code> become tap-to-copy in Telegram, which is what the
 * admin lists use so nobody types chat ids by hand). Chunking prefers newline
 * boundaries and the HTML we emit keeps tags within a line, so a split can't
 * tear a tag apart.
 */
export async function replyLong(
  ctx: Context,
  text: string,
  opts?: { html?: boolean },
): Promise<void> {
  for (const chunk of splitTelegramMessage(text)) {
    await ctx.reply(chunk, opts?.html ? { parse_mode: 'HTML' } : undefined);
  }
}
