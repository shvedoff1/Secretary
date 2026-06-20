import type { Context } from 'grammy';
import { routeMessage, isAddressed } from '../triggers.js';
import { getEditTarget } from '../editTargets.js';
import { runAndRespond, rewordPending } from '../flows/assist.js';
import { handleReceiptPhoto } from './onPhoto.js';

export async function onMessage(ctx: Context): Promise<void> {
  const text = ctx.message?.text;
  if (!text || !ctx.chat || !ctx.from) return;
  if (text.startsWith('/')) return; // commands handled elsewhere

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

  const decision = routeMessage(ctx, text);
  if (decision === 'ignore') return;

  await runAndRespond(ctx, {
    userContent: text,
    addressed: decision === 'process',
    source: 'text',
    historyText: text,
  });
}
