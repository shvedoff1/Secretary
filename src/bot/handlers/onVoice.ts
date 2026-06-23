import type { Context } from 'grammy';
import { logger } from '../../logger.js';
import { isAddressed, routeMessage } from '../triggers.js';
import { runAndRespond } from '../flows/assist.js';
import { downloadTelegramFile } from '../../util/telegramFile.js';
import { isTranscriptionEnabled, transcribeAudio } from '../../llm/transcribe.js';

/**
 * Voice messages: download the audio, transcribe it, then feed the transcript
 * into the same path as a typed message. In groups the bot transcribes every
 * voice note and routes the transcript like text — acting only when addressed
 * or when it looks like an expense, staying silent otherwise.
 */
export async function onVoice(ctx: Context): Promise<void> {
  const voice = ctx.message?.voice;
  if (!voice || !ctx.chat || !ctx.from) return;

  const addressed = isAddressed(ctx);

  if (!isTranscriptionEnabled()) {
    // Only nag when the user is clearly talking to us; stay quiet in groups.
    if (addressed) {
      await ctx.reply('Распознавание голоса не настроено. Напиши текстом, пожалуйста.');
    }
    return;
  }

  let transcript: string;
  try {
    const audio = await downloadTelegramFile(ctx, voice.file_id);
    transcript = await transcribeAudio(audio, 'voice.ogg', voice.mime_type ?? 'audio/ogg');
  } catch (err) {
    logger.error({ err }, 'failed to transcribe voice message');
    if (addressed) await ctx.reply('Не смог распознать голосовое, попробуй ещё раз.');
    return;
  }

  if (!transcript) {
    if (addressed) await ctx.reply('Не расслышал — в голосовом не было речи.');
    return;
  }

  // Route the transcript exactly like a text message: addressed → process,
  // looks-like-expense → silent auto-expense, otherwise ignore.
  const decision = routeMessage(ctx, transcript);
  if (decision === 'ignore') return;

  await runAndRespond(ctx, {
    userContent: transcript,
    addressed: decision === 'process',
    source: 'voice',
    historyText: `[голос] ${transcript}`,
  });
}
