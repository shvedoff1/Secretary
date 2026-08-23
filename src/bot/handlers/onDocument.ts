import type { Context } from 'grammy';
import type Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from '../../config.js';
import { logger } from '../../logger.js';
import { isAddressed, mentionsBotByName } from '../triggers.js';
import { runAndRespond, senderName } from '../flows/assist.js';
import { downloadTelegramFile } from '../../util/telegramFile.js';
import { forwardOrigin, isForwarded } from '../forwarded.js';
import { recordChatLog } from '../chatLog.js';
import { bufferForward, isForwardBufferEnabled, FORWARD_MARK } from '../forwardBuffer.js';
import { FILE_ATTACHMENT_MARKER } from '../../llm/prompts.js';
import { armPendingFile, type PendingFile } from '../pendingFile.js';
import { buildFileBlocks, classifyFile, fileKindLabel, type FileKind } from '../media.js';

/**
 * Attached files («док»). The rule, in one line: a file the user EXPLAINED is
 * read straight away; a file dropped with nothing said is ASKED about, not read.
 *
 * That split is deliberate. Reading a PDF costs a real slice of the turn — and a
 * bare «вот» says nothing about what to do with it, so the model would have to
 * guess at a summary nobody ordered. Asking costs zero tokens (it's a canned
 * line) and the file is parked for a few minutes, so the answer to «вытащи суммы»
 * arrives without a re-upload. An IMAGE sent as a file is the exception: that is
 * a photo that happened to skip compression, so it follows the photo rule and is
 * looked at right away.
 *
 * An UNADDRESSED file in a group is ignored outright — no download, no model
 * call, exactly like an unaddressed photo. Files fly around group chats all day
 * and none of them are a question to the bot.
 */
export async function onDocument(ctx: Context): Promise<void> {
  const doc = ctx.message?.document;
  if (!doc || !ctx.chat || !ctx.from) return;
  // Telegram sends GIFs (and other auto-playing clips) with BOTH `animation` and
  // `document` set. Those are chatter, not attachments — leave them alone.
  if (ctx.message?.animation) return;

  const caption = ctx.message?.caption?.trim() ?? '';
  const fileName = doc.file_name?.trim() || 'файл';

  recordChatLog({
    chatId: ctx.chat.id,
    role: 'user',
    kind: 'file',
    tgUserId: ctx.from.id,
    senderName: senderName(ctx),
    content: caption ? `(файл: ${fileName}) ${caption}` : `(файл: ${fileName})`,
    forwarded: isForwarded(ctx.message),
  });

  // A FORWARDED file joins the pack like a forwarded photo — as its name and
  // caption. It's someone else's document; answering each one is the noise the
  // batch exists to prevent.
  if (isForwardBufferEnabled() && isForwarded(ctx.message)) {
    bufferForward(ctx.chat.id, {
      messageId: ctx.message!.message_id,
      origin: forwardOrigin(ctx.message) ?? 'источник неизвестен',
      kind: 'document',
      text: caption ? `${fileName} — ${caption}` : fileName,
    });
    try {
      await ctx.react(FORWARD_MARK);
    } catch {
      /* best-effort */
    }
    return;
  }

  const addressed = isAddressed(ctx) || (!!caption && mentionsBotByName(caption));
  if (!addressed) return;

  const cfg = loadConfig();
  if (!cfg.ENABLE_FILE_INPUT) return;

  const kind = classifyFile(doc.mime_type, doc.file_name);
  if (kind === 'unsupported') {
    await ctx.reply(
      `Файл «${fileName}» я открыть не смогу — умею картинки, PDF и текстовые ` +
        `файлы. Если внутри что-то важное, пришли картинкой или текстом.`,
    );
    return;
  }

  const maxBytes = cfg.FILE_MAX_MB * 1024 * 1024;
  if ((doc.file_size ?? 0) > maxBytes) {
    await ctx.reply(
      `Файл «${fileName}» великоват (лимит ${cfg.FILE_MAX_MB} МБ) — пришли кусок ` +
        `поменьше или скажи, что именно из него нужно.`,
    );
    return;
  }

  const file: PendingFile = {
    fileId: doc.file_id,
    fileName,
    mimeType: doc.mime_type,
    kind,
    messageId: ctx.message!.message_id,
  };

  // Was anything actually asked? A caption is the ask; so is dropping the file as
  // a reply to the bot's own message (that's the bot's question being answered
  // with the file). An image needs no ask at all — see the photo rule above.
  const explained = caption.length > 0 || ctx.message?.reply_to_message?.from?.id === ctx.me.id;
  if (kind !== 'image' && !explained) {
    armPendingFile(ctx.chat.id, file);
    await ctx.reply(askWhatToDo(fileName, kind, cfg.PENDING_FILE_TTL_MINUTES));
    return;
  }

  await runFileTurn(ctx, file, caption);
}

/** The zero-token question. Deliberately canned: it costs nothing, always says
 *  the same thing, and names what the bot can actually do with THIS kind of file. */
export function askWhatToDo(fileName: string, kind: FileKind, ttlMinutes: number): string {
  const can =
    kind === 'pdf'
      ? 'прочитать и пересказать, найти в нём нужное, вытащить текст, суммы или даты'
      : 'прочитать, пересказать, найти в нём нужное, посчитать по нему';
  return (
    `Вижу ${fileKindLabel(kind)} «${fileName}». Что с ним сделать? Могу ${can}. ` +
    `Напиши, что нужно — файл держу под рукой ещё ${ttlMinutes} мин.`
  );
}

/**
 * Download an attached file and run it through the assistant with whatever the
 * user asked. Shared by the document handler, the "reply to a file" path and the
 * parked-file claim in onMessage.
 */
export async function runFileTurn(
  ctx: Context,
  file: PendingFile,
  instruction: string,
): Promise<void> {
  if (!ctx.chat) return;
  const cfg = loadConfig();

  let bytes: Buffer;
  try {
    bytes = await downloadTelegramFile(ctx, file.fileId);
  } catch (err) {
    logger.error({ err, fileName: file.fileName }, 'failed to download attached file');
    await ctx.reply('Не смог скачать файл, пришли ещё раз.');
    return;
  }

  const fileBlocks = buildFileBlocks(file, bytes, cfg.FILE_TEXT_MAX_CHARS);
  if (!fileBlocks) return; // classified as unsupported — already answered above

  // The marker tells the model this turn carries an ATTACHMENT and what it is;
  // the SYSTEM_PROMPT explains the literal (a test pins the two together), so a
  // chat rule can key on «файлы» the same way it can on «голосовые».
  const marker = `${FILE_ATTACHMENT_MARKER} (${file.fileName}, ${fileKindLabel(file.kind)})`;
  const blocks: Anthropic.ContentBlockParam[] = [
    { type: 'text', text: marker },
    ...fileBlocks,
  ];
  if (instruction) blocks.push({ type: 'text', text: instruction });

  await runAndRespond(ctx, {
    userContent: blocks,
    addressed: true,
    source: 'file',
    historyText: instruction
      ? `[файл: ${file.fileName}] ${instruction}`
      : `[файл: ${file.fileName}]`,
    includeForwardBatch: true,
  });
}
