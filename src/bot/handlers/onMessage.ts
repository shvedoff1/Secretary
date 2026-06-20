import type { Context } from 'grammy';
import { routeMessage } from '../triggers.js';
import { getEditTarget } from '../editTargets.js';
import { runAndRespond, rewordPending } from '../flows/assist.js';

export async function onMessage(ctx: Context): Promise<void> {
  const text = ctx.message?.text;
  if (!text || !ctx.chat || !ctx.from) return;
  if (text.startsWith('/')) return; // commands handled elsewhere

  // Reword: a reply to a preview message re-parses the expense.
  const replyTo = ctx.message?.reply_to_message;
  if (replyTo) {
    const pendingId = getEditTarget(ctx.chat.id, replyTo.message_id);
    if (pendingId) {
      await rewordPending(ctx, pendingId, replyTo.message_id, text);
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
