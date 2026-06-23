import type { Context } from 'grammy';
import { routeMessage, isAddressed, addressesBotByName } from '../triggers.js';
import { getEditTarget } from '../editTargets.js';
import { runAndRespond, rewordPending } from '../flows/assist.js';
import { learnFromMessage } from '../flows/lexicon.js';
import { handleReceiptPhoto } from './onPhoto.js';

export async function onMessage(ctx: Context): Promise<void> {
  const text = ctx.message?.text;
  if (!text || !ctx.chat || !ctx.from) return;
  if (text.startsWith('/')) return; // commands handled elsewhere

  // Passively learn the chat's slang from every message — even ones we won't reply
  // to (that's the point: read the whole room). Fire-and-forget and best-effort, so
  // it never delays or breaks the reply below.
  void learnFromMessage(ctx.chat.id, text);

  const replyTo = ctx.message?.reply_to_message;
  if (replyTo) {
    // Reword: a reply to a preview message re-parses the expense.
    const pendingId = getEditTarget(ctx.chat.id, replyTo.message_id);
    if (pendingId) {
      await rewordPending(ctx, pendingId, replyTo.message_id, text);
      return;
    }
    // Reply to a photo while pinging the bot → look at that photo regardless,
    // using this message's text as the instruction/context.
    if (replyTo.photo && replyTo.photo.length > 0 && isAddressed(ctx)) {
      await handleReceiptPhoto(ctx, replyTo.photo, text, true);
      return;
    }
  }

  // Addressed → process; looks-like-expense → silent auto-expense; else ignore.
  // Also answer a by-name question to the bot ("Скай, какая погода?") even when
  // it isn't a reply/@mention — same rule as voice notes.
  let decision = routeMessage(ctx, text);
  if (decision !== 'process' && addressesBotByName(text)) {
    decision = 'process';
  }
  if (decision === 'ignore') return;

  await runAndRespond(ctx, {
    userContent: text,
    addressed: decision === 'process',
    source: 'text',
    historyText: text,
  });
}
