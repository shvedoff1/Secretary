import type { Context } from 'grammy';
import {
  routeMessage,
  isAddressed,
  addressesBotByName,
  isFreshBotRequest,
} from '../triggers.js';
import { getEditTarget } from '../editTargets.js';
import { runAndRespond, rewordPending, senderName } from '../flows/assist.js';
import { learnFromMessage } from '../flows/lexicon.js';
import { learnMemoryFromMessage } from '../flows/memory.js';
import { recordChatMessage, armChime } from '../flows/chime.js';
import { getTranscript } from '../transcriptCache.js';
import { handleReceiptPhoto } from './onPhoto.js';
import { getChatMode } from '../../db/repos/chatSettings.repo.js';
import { modeAllowsChime, modeAllowsSlang } from '../../modes.js';
import { forwardOrigin, isForwarded, passiveLearningAllowed } from '../forwarded.js';
import { recordChatLog } from '../chatLog.js';
import {
  bufferForward,
  isForwardBufferEnabled,
  FORWARD_MARK,
} from '../forwardBuffer.js';

export async function onMessage(ctx: Context): Promise<void> {
  const text = ctx.message?.text;
  if (!text || !ctx.chat || !ctx.from) return;
  if (text.startsWith('/')) return; // commands handled elsewhere

  // What the chat's MODE allows: a tutor room learns no slang (the tutor never
  // speaks it) and neither a tutor nor a calm assistant chat ever chimes in on its
  // own — just question → answer. (armChime re-checks the mode itself.)
  const mode = getChatMode(ctx.chat.id);
  const learnsSlang = modeAllowsSlang(mode);
  const chimes = modeAllowsChime(mode);

  // FORWARDED messages are someone else's words about someone else's life: learning
  // slang from them makes the bot speak a stranger's voice, and learning facts from
  // them fills the chat's memory with things nobody here said. Skipped by default
  // (LEARN_FROM_FORWARDS brings it back) — the model still SEES the message, marked
  // as forwarded, so chat rules decide the rest.
  const learnable = passiveLearningAllowed(ctx.message);

  // Passively learn the chat's slang from every message — even ones we won't reply
  // to (that's the point: read the whole room). Fire-and-forget and best-effort, so
  // it never delays or breaks the reply below.
  if (learnsSlang && learnable) void learnFromMessage(ctx.chat.id, text);
  // Likewise build the chat's weighted long-term memory (durable facts about the
  // group and its people) from every message. Fire-and-forget and best-effort.
  if (learnable) void learnMemoryFromMessage(ctx.chat.id, ctx.from.id, senderName(ctx), text);
  // Keep a rolling buffer of recent chatter so a later spontaneous chime has the
  // conversation to continue from — independent of whether we reply to this one.
  recordChatMessage(ctx.chat.id, senderName(ctx), text);

  // Persist the same line to the chat's raw log — the durable, per-chat record the
  // `summarize_chat` tool reads back («перескажи последние 200 сообщений»). Unlike
  // the ring buffer above it survives restarts, and unlike conversation_turn it
  // keeps the messages the bot never replied to. A forward is tagged as such.
  recordChatLog({
    chatId: ctx.chat.id,
    role: 'user',
    kind: 'text',
    tgUserId: ctx.from.id,
    senderName: senderName(ctx),
    content: text,
    forwarded: isForwarded(ctx.message),
  });

  // FORWARDED message → the batch, not a reply. Forwards are someone else's words
  // passed along: answering each one (or scanning it for expenses) is noise, so it
  // is collected into the per-chat pack and marked with a reaction. The pack is
  // consumed by the user's next addressed message («сделай саммари») or by a tap
  // on the mark — see forwardBuffer.ts. In a DM this also stops the bot from
  // replying to every single forward.
  if (isForwardBufferEnabled() && isForwarded(ctx.message)) {
    bufferForward(ctx.chat.id, {
      messageId: ctx.message!.message_id,
      origin: forwardOrigin(ctx.message) ?? 'источник неизвестен',
      kind: 'text',
      text,
    });
    try {
      await ctx.react(FORWARD_MARK);
    } catch {
      /* reactions are best-effort */
    }
    return;
  }

  const replyTo = ctx.message?.reply_to_message;
  if (replyTo) {
    // Reword: a reply to a preview message re-parses the expense — but only when
    // it's an actual correction. A reply that @mentions the bot or addresses it by
    // name with a question/request ("@bot обнови прогноз по Бали") is a NEW ask, not
    // an edit to the trade, so let it fall through to normal processing (full
    // history/memory/tools) instead of being force-parsed as an expense and dying
    // with "Не понял правку". Bare corrections ("это Миша", "дели на всех") aren't
    // fresh requests, so they still reword. The reword flow itself also degrades
    // gracefully now (answers a non-correction) as a backstop for this heuristic.
    const pendingId = getEditTarget(ctx.chat.id, replyTo.message_id);
    if (pendingId && !isFreshBotRequest(ctx, text)) {
      await rewordPending(ctx, pendingId, replyTo.message_id, text);
      return;
    }
    // Reply to a photo while pinging the bot → look at that photo regardless,
    // using this message's text as the instruction/context. Keep the photo's
    // ORIGINAL caption too: it usually carries the real instruction (e.g.
    // «Скай, на меня Ивана и Антона»), and replying «это трата» without it
    // would drop that and make the bot split the expense among everyone.
    if (replyTo.photo && replyTo.photo.length > 0 && isAddressed(ctx)) {
      const photoCaption = replyTo.caption ? `${replyTo.caption}\n\n${text}` : text;
      await handleReceiptPhoto(ctx, replyTo.photo, photoCaption, true);
      return;
    }
  }

  // Addressed → process; looks-like-expense → silent auto-expense; else ignore.
  // Also answer a by-name question to the bot ("Скай, какая погода?") even when
  // it isn't a reply/@mention — same rule as voice notes.
  let decision = routeMessage(ctx, text);
  if (decision !== 'process' && addressesBotByName(text)) {
    decision = 'process';
  }
  if (decision === 'ignore') {
    // Not for us — start the silence countdown. If the chat then stays quiet for a
    // minute, the bot rolls the dice and may chime in to keep the conversation going.
    if (chimes) armChime(ctx);
    return;
  }

  // When the user replies to some other message and addresses us (e.g. «запомни,
  // это трата» pointing at a spend we missed), include that referenced message as
  // context so the assistant can act on the example — e.g. record it or learn its
  // expense keywords. Earlier branches already handled replies to our preview/photo.
  // A replied-to VOICE note has no text/caption, so fall back to its cached
  // transcript (stashed when we transcribed it) — otherwise the bot would see the
  // user's «это трата» with no idea which expense they mean.
  const quoted =
    replyTo?.text ??
    replyTo?.caption ??
    (replyTo ? getTranscript(ctx.chat.id, replyTo.message_id) : undefined);
  // Name the author of the quoted message so the assistant attributes it correctly
  // (and doesn't answer/tag the wrong person when acting on a reply).
  const quotedAuthor = replyTo?.from
    ? [replyTo.from.first_name, replyTo.from.last_name].filter(Boolean).join(' ') ||
      (replyTo.from.username ? `@${replyTo.from.username}` : null)
    : null;
  const quotedLabel = quotedAuthor ? `сообщение от ${quotedAuthor}` : 'сообщение';
  const userContent =
    decision === 'process' && quoted
      ? `[В ответ на ${quotedLabel}: "${quoted}"]\n${text}`
      : text;

  await runAndRespond(ctx, {
    userContent,
    addressed: decision === 'process',
    source: 'text',
    historyText: text,
    // An addressed message right after a forwarded pack is the ask the pack was
    // forwarded for («сделай саммари») — pull it into this turn.
    includeForwardBatch: true,
  });
}
