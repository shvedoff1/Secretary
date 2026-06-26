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
import { runAndRespond } from '../flows/assist.js';
import { downloadTelegramFile } from '../../util/telegramFile.js';

export async function onPhoto(ctx: Context): Promise<void> {
  const photos = ctx.message?.photo;
  if (!photos || photos.length === 0 || !ctx.chat || !ctx.from) return;

  const caption = ctx.message?.caption?.trim() ?? '';
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
 * Download a photo and run it through the assistant as a receipt. Shared by the
 * photo handler and the "reply to a photo with a ping" path in onMessage.
 */
export async function handleReceiptPhoto(
  ctx: Context,
  photos: readonly { file_id: string }[],
  caption: string,
  addressed: boolean,
): Promise<void> {
  if (!ctx.chat || photos.length === 0) return;

  const chatCfg = getChatConfig(ctx.chat.id);
  if (!chatCfg?.provider_group_id) {
    if (addressed) {
      await ctx.reply('Подключите группу Splid командой /group <код>, чтобы я разбирал чеки.');
    }
    return;
  }

  const largest = photos[photos.length - 1]!;
  let base64: string;
  try {
    base64 = (await downloadTelegramFile(ctx, largest.file_id)).toString('base64');
  } catch (err) {
    logger.error({ err }, 'failed to download receipt photo');
    if (addressed) await ctx.reply('Не смог скачать фото чека, попробуйте ещё раз.');
    return;
  }

  const blocks: Anthropic.ContentBlockParam[] = [
    {
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: base64 },
    },
  ];
  if (caption) blocks.push({ type: 'text', text: caption });

  await runAndRespond(ctx, {
    userContent: blocks,
    addressed,
    source: 'photo',
    historyText: caption ? `[чек] ${caption}` : '[чек]',
  });
}
