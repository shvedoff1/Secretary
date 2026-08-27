import type { Context } from 'grammy';
import type Anthropic from '@anthropic-ai/sdk';
import { logger } from '../../logger.js';
import {
  isAddressed,
  looksLikeExpenseForChat,
  captionLooksLikeSharedExpense,
  mentionsBotByName,
} from '../triggers.js';
import { runAndRespond, senderName } from '../flows/assist.js';
import { downloadTelegramFile } from '../../util/telegramFile.js';
import { forwardOrigin, isForwarded } from '../forwarded.js';
import { recordChatLog } from '../chatLog.js';
import {
  bufferForward,
  isForwardBufferEnabled,
  FORWARD_MARK,
} from '../forwardBuffer.js';

export async function onPhoto(ctx: Context): Promise<void> {
  const photos = ctx.message?.photo;
  if (!photos || photos.length === 0 || !ctx.chat || !ctx.from) return;

  const caption = ctx.message?.caption?.trim() ?? '';

  // A photo is part of what happened in the chat even when the bot ignores it, so
  // it lands in the raw log (caption, or a bare marker) for later recaps.
  recordChatLog({
    chatId: ctx.chat.id,
    role: 'user',
    kind: 'photo',
    tgUserId: ctx.from.id,
    senderName: senderName(ctx),
    content: caption || '(фото без подписи)',
    forwarded: isForwarded(ctx.message),
  });

  // A FORWARDED photo goes to the forward batch, not the assistant: it's someone
  // else's picture (an album arrives as one such message per photo), and answering
  // each one is exactly the spam the batch exists to avoid. The file_id rides
  // along so the drain can attach the actual picture to the consuming turn —
  // caption-only buffering made «что на картинке?» over a forward unanswerable.
  // Nothing is downloaded here: an expired pack costs zero downloads.
  if (isForwardBufferEnabled() && isForwarded(ctx.message)) {
    const largest = photos[photos.length - 1]!;
    bufferForward(ctx.chat.id, {
      messageId: ctx.message!.message_id,
      origin: forwardOrigin(ctx.message) ?? 'источник неизвестен',
      kind: 'photo',
      text: caption,
      // Telegram-compressed photos are always JPEG.
      image: { fileId: largest.file_id, mediaType: 'image/jpeg' },
    });
    try {
      await ctx.react(FORWARD_MARK);
    } catch {
      /* best-effort */
    }
    return;
  }
  // Addressed = DM / @mention / reply to the bot, OR the caption talks to it by
  // name ("Скай, на меня Ивана и Антона") — the user is clearly talking to us, so
  // we both look at the photo and answer.
  const addressed = isAddressed(ctx) || (!!caption && mentionsBotByName(caption));
  // Even when NOT addressed, a captioned photo is very likely a receipt to split
  // when the caption looks like a shared expense — either the usual numeric
  // heuristic ("чек на 1200 за ужин") or just names/allocation attached with no
  // number ("на меня Ивана и Антона"), since the amount is in the picture. A bare
  // picture with no relevant caption is still ignored — we don't OCR every photo.
  const sharedExpense =
    !!caption &&
    (looksLikeExpenseForChat(ctx.chat.id, caption) || captionLooksLikeSharedExpense(caption));
  if (!addressed && !sharedExpense) return;

  // Not addressed but caption implies a split → look at it, but stay silent unless
  // it really is an expense (addressed=false ⇒ runAndRespond returns 'silent' on a
  // non-expense), so a false positive costs only a wasted model call, never noise.
  await handlePhotoTurn(ctx, photos, caption, addressed);
}

/**
 * Download a photo and run it through the assistant. A photo is just a photo:
 * the MODEL decides what it is — a receipt to split (only where Splid is
 * connected, which it reads from the context block), a problem from a textbook in
 * tutor mode, a screenshot to read, a place to identify. There is deliberately NO
 * Splid gate here: gating the whole picture on a connected group made the bot
 * answer «подключите группу Splid» to a photo of a cat in an assistant-mode DM —
 * an add-on nobody asked about growing over the one thing that was asked. Shared
 * by the photo handler and the "reply to a photo with a ping" paths in
 * onMessage/onVoice.
 */
export async function handlePhotoTurn(
  ctx: Context,
  photos: readonly { file_id: string }[],
  caption: string,
  addressed: boolean,
): Promise<void> {
  if (!ctx.chat || photos.length === 0) return;

  const largest = photos[photos.length - 1]!;
  let base64: string;
  try {
    base64 = (await downloadTelegramFile(ctx, largest.file_id)).toString('base64');
  } catch (err) {
    logger.error({ err }, 'failed to download photo');
    if (addressed) await ctx.reply('Не смог скачать фото, попробуйте ещё раз.');
    return;
  }

  const blocks: Anthropic.ContentBlockParam[] = [
    {
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: base64 },
    },
  ];
  if (caption) blocks.push({ type: 'text', text: caption });

  // History tag: «[фото]», not «[чек]». The turn is a picture — calling it a
  // receipt in the history primes the next turn to read every photo as a bill.
  await runAndRespond(ctx, {
    userContent: blocks,
    addressed,
    source: 'photo',
    historyText: caption ? `[фото] ${caption}` : '[фото]',
    // A photo with an addressed caption is a real ask too — consume the pack.
    includeForwardBatch: true,
  });
}
