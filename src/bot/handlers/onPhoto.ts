import type { Context } from 'grammy';
import type Anthropic from '@anthropic-ai/sdk';
import { logger } from '../../logger.js';
import { isAddressed, looksLikeExpense } from '../triggers.js';
import { getChatConfig } from '../../db/repos/chatConfig.repo.js';
import { runAndRespond } from '../flows/assist.js';
import { downloadTelegramFile } from '../../util/telegramFile.js';

export async function onPhoto(ctx: Context): Promise<void> {
  const photos = ctx.message?.photo;
  if (!photos || photos.length === 0 || !ctx.chat || !ctx.from) return;

  const caption = ctx.message?.caption?.trim() ?? '';
  const addressed = isAddressed(ctx);
  // Read a photo when the bot is addressed (DM / @mention / reply to the bot)
  // OR the caption itself looks like an expense ("чек на 1200 за ужин"). A bare
  // picture with no relevant caption is ignored — we don't OCR every photo.
  if (!addressed && !(caption && looksLikeExpense(caption))) return;

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
