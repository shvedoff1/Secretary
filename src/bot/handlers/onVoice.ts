import type { Context } from 'grammy';
import { loadConfig } from '../../config.js';
import { logger } from '../../logger.js';
import { isAddressed, routeMessage, addressesBotByName } from '../triggers.js';
import { runAndRespond } from '../flows/assist.js';
import { learnFromMessage } from '../flows/lexicon.js';
import { downloadTelegramFile } from '../../util/telegramFile.js';
import { isTranscriptionEnabled, transcribeAudio } from '../../llm/transcribe.js';
import { setTranscript } from '../transcriptCache.js';

// "Writing it down" marker. We react with ✍️ as soon as a voice note arrives, so
// the chat sees it was heard; the mark stays only if it became an expense and is
// removed otherwise. Note: the valid Telegram reaction literal is the bare ✍
// (U+270D), without the emoji variation selector.
const WRITING = '✍' as const;

async function setWriting(ctx: Context): Promise<void> {
  try {
    await ctx.react(WRITING);
  } catch {
    /* reactions are best-effort (disabled in chat, missing rights, …) */
  }
}

async function clearWriting(ctx: Context): Promise<void> {
  try {
    await ctx.react([]);
  } catch {
    /* best-effort */
  }
}

/**
 * Forward a voice transcript to the admin's DM so flaky transcriptions can be
 * spotted even in chats the admin doesn't actively watch. Best-effort: never
 * throws, never blocks the main flow. Skipped when the admin sent the note in
 * their own DM (the transcript is already in front of them).
 */
async function dmTranscriptToAdmin(ctx: Context, transcript: string): Promise<void> {
  try {
    const adminId = loadConfig().ADMIN_TELEGRAM_ID;
    if (!ctx.chat || ctx.chat.id === adminId) return;
    const chatLabel =
      ctx.chat.type !== 'private' && 'title' in ctx.chat && ctx.chat.title
        ? ctx.chat.title
        : 'личка';
    const from = ctx.from
      ? [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') ||
        (ctx.from.username ? `@${ctx.from.username}` : `id ${ctx.from.id}`)
      : 'кто-то';
    await ctx.api.sendMessage(
      adminId,
      `🎤 Голосовое (${chatLabel}, ${from}) расшифровалось как:\n\n${transcript}`,
    );
  } catch (err) {
    logger.warn({ err }, 'failed to DM voice transcript to admin');
  }
}

/**
 * Voice messages: download the audio, transcribe it, then feed the transcript
 * into the same path as a typed message. In groups the bot transcribes every
 * voice note and routes the transcript like text — acting only when addressed
 * or when it looks like an expense, staying silent otherwise.
 *
 * We mark every (transcribable) voice note with a ✍️ reaction up front and clear
 * it unless the note turned into a recorded expense, so the chat gets a light
 * acknowledgement that the bot heard it.
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

  // Acknowledge receipt; cleared below unless this becomes an expense.
  await setWriting(ctx);

  let transcript: string;
  try {
    const audio = await downloadTelegramFile(ctx, voice.file_id);
    transcript = await transcribeAudio(audio, 'voice.ogg', voice.mime_type ?? 'audio/ogg');
  } catch (err) {
    logger.error({ err }, 'failed to transcribe voice message');
    await clearWriting(ctx);
    if (addressed) await ctx.reply('Не смог распознать голосовое, попробуй ещё раз.');
    return;
  }

  if (!transcript) {
    await clearWriting(ctx);
    if (addressed) await ctx.reply('Не расслышал — в голосовом не было речи.');
    return;
  }

  // Remember the transcript keyed by this voice note's message id, so if someone
  // later REPLIES to it («запомни, это трата» / «это была трата») the reply handler
  // can recover what was said — a voice note carries no text/caption of its own.
  setTranscript(ctx.chat.id, ctx.message!.message_id, transcript);

  // DM the admin what we heard, so they can catch flaky transcriptions even in
  // chats they don't actively watch. Best-effort; skip when the admin themselves
  // sent the note in their own DM (they'd just get a duplicate).
  void dmTranscriptToAdmin(ctx, transcript);

  // Learn the chat's slang from the transcript too — every message counts, not
  // just the ones we reply to. Fire-and-forget and best-effort.
  void learnFromMessage(ctx.chat.id, transcript);

  // Route the transcript exactly like a text message: addressed → process,
  // looks-like-expense → silent auto-expense, otherwise ignore. A voice note
  // can't @mention or reply, so also treat a by-name question to the bot
  // ("Скай, какая погода?") as addressed and answer it.
  let decision = routeMessage(ctx, transcript);
  if (decision !== 'process' && addressesBotByName(transcript)) {
    decision = 'process';
  }
  if (decision === 'ignore') {
    await clearWriting(ctx);
    return;
  }

  // We own the reaction here (✍️ already set), so tell runAndRespond not to
  // manage its own 👀 indicator. Keep ✍️ only when an expense was drafted.
  const outcome = await runAndRespond(ctx, {
    userContent: transcript,
    addressed: decision === 'process',
    source: 'voice',
    historyText: `[голос] ${transcript}`,
    manageReaction: false,
  });
  if (outcome !== 'expense') await clearWriting(ctx);
}
