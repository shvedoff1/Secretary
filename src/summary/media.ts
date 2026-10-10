// `view_media`: open ONE logged picture on demand.
//
// Media in a busy chat is logged as a REFERENCE (see migration 035): who sent it,
// when, the caption, a link, and a file_id of something cheap to look at — the
// photo itself, or a video's thumbnail. Nothing is downloaded at log time. When a
// recap or a bug candidate actually hinges on what is IN a picture («что на том
// скрине?»), the model passes the «[медиа #N]» number here and gets that single
// image — one picture's worth of tokens, never the whole chat's.

import type Anthropic from '@anthropic-ai/sdk';
import type { Api } from 'grammy';
import { logger } from '../logger.js';
import { getLogEntry } from '../db/repos/chatLog.repo.js';
import { downloadTelegramFileVia } from '../util/telegramFile.js';
import { messageLink } from '../util/telegramLink.js';
import type { ViewMediaInput } from '../llm/schema.js';

/** Claude's per-image ceiling; bigger files are refused rather than sent to fail. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export type MediaToolContent = string | Anthropic.ToolResultBlockParam['content'];

type ImageType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

/**
 * Sniff the image type from magic bytes. The log keeps only a file_id, not a mime
 * type, and Telegram serves photos/thumbnails as JPEG but an image sent as a FILE
 * as whatever it was — a PNG labelled jpeg is rejected by the API.
 */
export function sniffImageType(buf: Buffer): ImageType | null {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 3 && buf.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

export function makeViewMediaHandler(
  chatId: number,
  api: Api,
): (input: ViewMediaInput) => Promise<MediaToolContent> {
  return async ({ ref }) => {
    const entry = getLogEntry(chatId, ref);
    if (!entry) {
      return `No logged message #${ref} in this chat (it may have aged out of the log). Tell the user you can't open it.`;
    }
    const link = messageLink(chatId, entry.messageId, entry.threadId);
    const where = link ? ` Source: ${link}` : '';
    if (!entry.mediaFileId) {
      return `Message #${ref} has nothing to open (a ${entry.kind} message without a picture).${where}`;
    }
    let buf: Buffer;
    try {
      buf = await downloadTelegramFileVia(api, entry.mediaFileId);
    } catch (err) {
      logger.warn({ err, chatId, ref }, 'view_media download failed');
      return `Could not download media #${ref} from Telegram (it may be too old or too big).${where} Tell the user, and give them the link if there is one.`;
    }
    if (buf.length > MAX_IMAGE_BYTES) {
      return `Media #${ref} is too large to look at (${Math.round(buf.length / 1024 / 1024)} MB).${where}`;
    }
    const type = sniffImageType(buf);
    if (!type) {
      return `Media #${ref} is not an image I can open.${where}`;
    }
    const who = entry.senderName ?? 'кто-то';
    const what =
      entry.kind === 'video'
        ? `This is ONLY the preview frame (thumbnail) of a VIDEO by ${who} — you have not seen the video itself; say so if it matters.`
        : `Picture by ${who}.`;
    logger.info({ chatId, ref, kind: entry.kind, bytes: buf.length }, 'view_media opened');
    return [
      { type: 'text', text: `${what} Caption/log line: «${entry.content}».${where}` },
      { type: 'image', source: { type: 'base64', media_type: type, data: buf.toString('base64') } },
    ];
  };
}
