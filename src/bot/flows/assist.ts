import type { Context } from 'grammy';
import type Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from '../../config.js';
import { logger } from '../../logger.js';
import { getProvider } from '../../core/registry.js';
import { buildDraft } from '../../core/expenseService.js';
import type { Member } from '../../core/types.js';
import { runAssistant } from '../../llm/assistant.js';
import { toParsedExpense } from '../../llm/schema.js';
import { getChatConfig, setChatTitle } from '../../db/repos/chatConfig.repo.js';
import { getMapping } from '../../db/repos/memberMap.repo.js';
import { getMemory, appendMemory } from '../../db/repos/memory.repo.js';
import {
  addTurn,
  recentTurns,
  pruneOld,
} from '../../db/repos/conversation.repo.js';
import { presentDraft, renderDraft, nameMapFromMembers } from './preview.js';
import {
  getPending,
  updateDraft,
  type PendingSource,
} from '../../db/repos/pending.repo.js';
import { previewKeyboard } from '../keyboards.js';

export function senderName(ctx: Context): string {
  const u = ctx.from;
  if (!u) return 'someone';
  return (
    [u.first_name, u.last_name].filter(Boolean).join(' ') ||
    (u.username ? `@${u.username}` : `user ${u.id}`)
  );
}

/**
 * Run the LLM assistant for a message and act on the result:
 * expense → preview; text → reply (unless this was a silent auto-expense scan).
 */
export async function runAndRespond(
  ctx: Context,
  args: {
    userContent: string | Anthropic.ContentBlockParam[];
    addressed: boolean;
    source: PendingSource;
    /** Plain text used for conversation history (e.g. caption or message text). */
    historyText: string;
  },
): Promise<void> {
  const cfg = loadConfig();
  const chatId = ctx.chat!.id;
  const tgUserId = ctx.from!.id;

  const chatCfg = getChatConfig(chatId);
  if (chatCfg && ctx.chat?.type !== 'private' && ctx.chat && 'title' in ctx.chat && ctx.chat.title) {
    setChatTitle(chatId, ctx.chat.title);
  }

  // Load the member roster (for name resolution + context) if configured.
  let members: Member[] = [];
  if (chatCfg?.provider_group_id) {
    try {
      members = await getProvider(chatCfg.provider_name).listMembers({
        groupId: chatCfg.provider_group_id,
      });
    } catch (err) {
      logger.warn({ err }, 'could not load members for context');
    }
  }

  const memory = getMemory(chatId);
  const history = recentTurns(chatId, cfg.CONVERSATION_HISTORY_LIMIT);

  const result = await runAssistant(
    {
      defaultCurrency: chatCfg?.default_currency ?? cfg.DEFAULT_CURRENCY,
      members: members.map((m) => ({ name: m.name, initials: m.initials })),
      memory,
      senderName: senderName(ctx),
      history,
      userContent: args.userContent,
    },
    {
      remember: (note) => {
        appendMemory(chatId, note);
        return 'Запомнил.';
      },
    },
  );

  // Record the user's turn for future context.
  addTurn({ chatId, role: 'user', tgUserId, content: args.historyText });

  if (result.kind === 'expense') {
    if (!chatCfg?.provider_group_id) {
      await ctx.reply(
        'Сначала подключите группу Splid командой /group <код-приглашения>.',
      );
      return;
    }
    const senderMapping = getMapping(chatId, tgUserId);
    const draft = buildDraft({
      parsed: toParsedExpense(result.input),
      members,
      senderMemberId: senderMapping?.provider_member_id ?? null,
      defaultCurrency: chatCfg.default_currency,
    });
    await presentDraft(ctx, {
      chatId,
      tgUserId,
      draft,
      source: args.source,
      members,
    });
    pruneOld(chatId, cfg.CONVERSATION_HISTORY_LIMIT * 2);
    return;
  }

  // Text result. For a silent auto-expense scan that produced no expense, stay quiet.
  if (!args.addressed) {
    pruneOld(chatId, cfg.CONVERSATION_HISTORY_LIMIT * 2);
    return;
  }

  await ctx.reply(result.text, {
    reply_to_message_id: ctx.message?.message_id,
  });
  addTurn({ chatId, role: 'assistant', tgUserId: null, content: result.text });
  pruneOld(chatId, cfg.CONVERSATION_HISTORY_LIMIT * 2);
}

/**
 * Re-parse a correction (a reply to a preview message) and update the existing
 * pending draft in place, editing the original preview message.
 */
export async function rewordPending(
  ctx: Context,
  pendingId: string,
  previewMessageId: number,
  correctionText: string,
): Promise<void> {
  const chatId = ctx.chat!.id;
  const tgUserId = ctx.from!.id;
  const pending = getPending(pendingId);
  if (!pending || pending.status !== 'awaiting') {
    await ctx.reply('Это превью уже неактивно.');
    return;
  }

  const cfg = loadConfig();
  const chatCfg = getChatConfig(chatId);
  if (!chatCfg?.provider_group_id) {
    await ctx.reply('Сначала подключите группу Splid командой /group.');
    return;
  }

  let members: Member[] = [];
  try {
    members = await getProvider(chatCfg.provider_name).listMembers({
      groupId: chatCfg.provider_group_id,
    });
  } catch (err) {
    logger.warn({ err }, 'could not load members for reword');
  }

  const result = await runAssistant(
    {
      defaultCurrency: chatCfg.default_currency,
      members: members.map((m) => ({ name: m.name, initials: m.initials })),
      memory: getMemory(chatId),
      senderName: senderName(ctx),
      history: [],
      userContent: correctionText,
    },
    { remember: (note) => (appendMemory(chatId, note), 'Запомнил.') },
  );

  if (result.kind !== 'expense') {
    await ctx.reply('Не понял это как трату. Попробуйте: «такси 500 за меня и Колю».');
    return;
  }

  const senderMapping = getMapping(chatId, tgUserId);
  const draft = buildDraft({
    parsed: toParsedExpense(result.input),
    members,
    senderMemberId: senderMapping?.provider_member_id ?? null,
    defaultCurrency: chatCfg.default_currency,
  });
  updateDraft(pendingId, draft);

  const text = renderDraft(draft, nameMapFromMembers(members));
  try {
    await ctx.api.editMessageText(chatId, previewMessageId, text, {
      reply_markup: previewKeyboard(pendingId),
    });
  } catch {
    await presentDraft(ctx, {
      chatId,
      tgUserId,
      draft,
      source: 'text',
      members,
    });
  }
}
