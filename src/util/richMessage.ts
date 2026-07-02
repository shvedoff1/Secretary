import type { Api } from 'grammy';
import { logger } from '../logger.js';
import { mdToTelegramHtml, stripMarkdown } from './telegramHtml.js';

export interface RichSendOptions {
  /** Reply to this message id (threaded reply). */
  replyToMessageId?: number;
  /** Suppress the link preview in the fallback paths (rich messages don't blow up
   *  bare URLs into a preview, so it only matters when we degrade). */
  disableLinkPreview?: boolean;
}

/**
 * Send `text` (the assistant's GitHub-flavoured markdown) using Telegram's native
 * rich-message formatting. Rich Markdown is GFM-compatible, so we hand the model's
 * markdown over untouched and Telegram renders tables, headings, lists, block quotes
 * and inline styling directly — no more markdown tables leaking through as raw pipes.
 *
 * Rich messages are recent (Bot API 10.1). If the server this bot talks to doesn't
 * support `sendRichMessage`, or rejects the payload, we degrade to the classic HTML
 * subset (which renders a table as an aligned <pre> block) and finally to plain text,
 * so a reply is never lost.
 */
export async function sendRichMarkdown(
  api: Api,
  chatId: number,
  text: string,
  opts: RichSendOptions = {},
): Promise<void> {
  const reply_parameters =
    opts.replyToMessageId != null ? { message_id: opts.replyToMessageId } : undefined;

  try {
    await api.sendRichMessage(
      chatId,
      { markdown: text },
      reply_parameters ? { reply_parameters } : {},
    );
    return;
  } catch (err) {
    logger.warn({ err, chatId }, 'rich message failed, falling back to HTML');
  }

  const linkPreview = opts.disableLinkPreview
    ? { link_preview_options: { is_disabled: true as const } }
    : {};
  try {
    await api.sendMessage(chatId, mdToTelegramHtml(text), {
      parse_mode: 'HTML',
      ...(reply_parameters ? { reply_parameters } : {}),
      ...linkPreview,
    });
    return;
  } catch (err) {
    logger.warn({ err, chatId }, 'HTML reply failed, falling back to plain text');
    await api.sendMessage(chatId, stripMarkdown(text), {
      ...(reply_parameters ? { reply_parameters } : {}),
      ...linkPreview,
    });
  }
}
