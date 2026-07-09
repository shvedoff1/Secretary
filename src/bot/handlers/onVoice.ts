import type { Context } from 'grammy';
import { loadConfig } from '../../config.js';
import { logger } from '../../logger.js';
import { isAddressed } from '../triggers.js';
import { runAndRespond, senderName } from '../flows/assist.js';
import { learnFromMessage } from '../flows/lexicon.js';
import { learnMemoryFromMessage } from '../flows/memory.js';
import { downloadTelegramFile } from '../../util/telegramFile.js';
import { isTranscriptionEnabled, transcribeAudio } from '../../llm/transcribe.js';
import { setTranscript } from '../transcriptCache.js';
import { handleReceiptPhoto } from './onPhoto.js';
import { t } from '../../i18n/index.js';

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
        : t('chat.dmChatLabel');
    const from = ctx.from
      ? [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') ||
        (ctx.from.username ? `@${ctx.from.username}` : `id ${ctx.from.id}`)
      : t('chat.someone');
    await ctx.api.sendMessage(
      adminId,
      t('chat.voiceTranscriptDm', { chat: chatLabel, from, transcript }),
    );
  } catch (err) {
    logger.warn({ err }, 'failed to DM voice transcript to admin');
  }
}

/**
 * Voice messages: download the audio, transcribe it, then feed the transcript
 * into the same path as a typed message. Every voice note is treated as a message
 * addressed TO the bot — exactly as if the transcript had been typed with a ping —
 * so the bot always responds to what was said (an expense still becomes a preview,
 * anything else a normal reply). It no longer stays silent on notes that don't name
 * the bot or look like a spend.
 *
 * We mark every (transcribable) voice note with a ✍️ reaction up front and clear
 * it unless the note turned into a recorded expense, so the chat gets a light
 * acknowledgement that the bot heard it.
 */
export async function onVoice(ctx: Context): Promise<void> {
  const voice = ctx.message?.voice;
  if (!voice || !ctx.chat || !ctx.from) return;

  // Whether the user was clearly, directly talking to us (DM / @mention / reply to
  // the bot). The voice CONTENT is always answered now (see below), but the
  // "couldn't hear you" edge-case replies stay gated on this so a failed or empty
  // voice note in a group doesn't fire an error message at everyone.
  const addressed = isAddressed(ctx);

  if (!isTranscriptionEnabled()) {
    // Only nag when the user is clearly talking to us; stay quiet in groups.
    if (addressed) {
      await ctx.reply(t('chat.voiceNotConfigured'));
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
    if (addressed) await ctx.reply(t('chat.voiceTranscribeFailed'));
    return;
  }

  if (!transcript) {
    await clearWriting(ctx);
    if (addressed) await ctx.reply(t('chat.voiceNoSpeech'));
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
  // Build weighted long-term memory from the transcript too. Best-effort.
  if (ctx.from) {
    void learnMemoryFromMessage(ctx.chat.id, ctx.from.id, senderName(ctx), transcript);
  }

  // A voice note REPLYING to a photo is a receipt split spoken aloud — the amounts
  // are in the picture, the voice says who had what. Feed BOTH the photo and the
  // transcript to the receipt handler (mirroring the text «reply to a photo» path in
  // onMessage) instead of routing the transcript as standalone text: on its own it
  // carries no numbers and wouldn't look like an expense. Keep the photo's original
  // caption too — it may hold the real instruction («Скай, на меня Ивана и Антона»).
  // Passed as addressed (like every voice note), matching the text ping-a-photo path
  // in onMessage, so the receipt handler shows its preview/answer rather than staying
  // silent.
  const replyTo = ctx.message!.reply_to_message;
  if (replyTo?.photo && replyTo.photo.length > 0) {
    const caption = replyTo.caption ? `${replyTo.caption}\n\n${transcript}` : transcript;
    // The ✍️ was just a "heard you" ack; the receipt handler owns the UI from here
    // (its own 👀 while working, then a preview), so drop our mark before delegating.
    await clearWriting(ctx);
    await handleReceiptPhoto(ctx, replyTo.photo, caption, true);
    return;
  }

  // Every voice note is treated as a message addressed to the bot — the same as a
  // text message that pings it. We no longer route/ignore transcripts by whether
  // they name the bot or look like an expense: the bot always responds to what was
  // said (an expense still becomes a preview, anything else a normal reply).
  //
  // We own the reaction here (✍️ already set), so tell runAndRespond not to
  // manage its own 👀 indicator. Keep ✍️ only when an expense was drafted.
  const outcome = await runAndRespond(ctx, {
    userContent: transcript,
    addressed: true,
    source: 'voice',
    historyText: `[голос] ${transcript}`,
    manageReaction: false,
  });
  if (outcome !== 'expense') await clearWriting(ctx);
}
