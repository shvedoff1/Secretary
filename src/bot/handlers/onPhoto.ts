import type { Context } from 'grammy';
import type Anthropic from '@anthropic-ai/sdk';
import { logger } from '../../logger.js';
import {
  isAddressed,
  looksLikeExpenseForChat,
  captionLooksLikeSharedExpense,
  mentionsBotByName,
} from '../triggers.js';
import { getChatConfig } from '../../db/repos/chatConfig.repo.js';
import { getChatMode } from '../../db/repos/chatSettings.repo.js';
import { runAndRespond } from '../flows/assist.js';
import { downloadTelegramFile } from '../../util/telegramFile.js';
import { forwardOrigin, isForwarded } from '../forwarded.js';
import {
  bufferForward,
  isForwardBufferEnabled,
  FORWARD_MARK,
} from '../forwardBuffer.js';

export async function onPhoto(ctx: Context): Promise<void> {
  const photos = ctx.message?.photo;
  if (!photos || photos.length === 0 || !ctx.chat || !ctx.from) return;

  const caption = ctx.message?.caption?.trim() ?? '';

  // A FORWARDED photo goes to the forward batch, not the receipt flow: it's
  // someone else's picture (an album arrives as one such message per photo), and
  // parsing each as a чек — or nagging about Splid in a DM — is exactly the spam
  // the batch exists to avoid. Buffered as caption-only: the batch is a text
  // digest; the model can ask for the photo if the caption isn't enough.
  if (isForwardBufferEnabled() && isForwarded(ctx.message)) {
    bufferForward(ctx.chat.id, {
      messageId: ctx.message!.message_id,
      origin: forwardOrigin(ctx.message) ?? 'источник неизвестен',
      kind: 'photo',
      text: caption,
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
  await handleReceiptPhoto(ctx, photos, caption, addressed);
}

/**
 * Download a photo and run it through the assistant — as a receipt in secretary
 * mode, or as a problem/exercise photo in tutor mode (a student photographs the
 * task from a textbook, so no Splid gate there). Shared by the photo handler and
 * the "reply to a photo with a ping" path in onMessage.
 */
export async function handleReceiptPhoto(
  ctx: Context,
  photos: readonly { file_id: string }[],
  caption: string,
  addressed: boolean,
): Promise<void> {
  if (!ctx.chat || photos.length === 0) return;

  const tutor = getChatMode(ctx.chat.id) === 'tutor';
  if (!tutor) {
    const chatCfg = getChatConfig(ctx.chat.id);
    if (!chatCfg?.provider_group_id) {
      if (addressed) {
        await ctx.reply('Подключите группу Splid командой /group <код>, чтобы я разбирал чеки.');
      }
      return;
    }
  }

  const largest = photos[photos.length - 1]!;
  let base64: string;
  try {
    base64 = (await downloadTelegramFile(ctx, largest.file_id)).toString('base64');
  } catch (err) {
    logger.error({ err }, 'failed to download receipt photo');
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

  const tag = tutor ? '[фото]' : '[чек]';
  await runAndRespond(ctx, {
    userContent: blocks,
    addressed,
    source: 'photo',
    historyText: caption ? `${tag} ${caption}` : tag,
    // A photo with an addressed caption is a real ask too — consume the pack.
    includeForwardBatch: true,
  });
}
