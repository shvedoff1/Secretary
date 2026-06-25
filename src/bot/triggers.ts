import type { Context } from 'grammy';
import { getExpenseTerms } from '../db/repos/expenseTerm.repo.js';

const EXPENSE_KEYWORDS =
  /(потрат|заплат|оплат|скинул|должен|долж|купил|чек|счет|счёт|за\s|spent|paid|bought|cost|bill|check|lunch|dinner|breakfast|taxi|такси|обед|ужин|завтрак|груш|product|groсer|store|shop|кафе|cafe|restaurant|рестора)/i;

/** Heuristic: does this text look like it reports a spend? Requires a number. */
export function looksLikeExpense(text: string): boolean {
  if (!/\d/.test(text)) return false;
  return EXPENSE_KEYWORDS.test(text);
}

/**
 * Like {@link looksLikeExpense}, but also consults the chat's LEARNED expense
 * dictionary (`chat_expense_term`) — words/phrases the user taught at runtime via
 * «запомни, это трата». Still requires a number (an expense reports an amount), so
 * a learned term alone can't misfire on chatter. Falls back to the base heuristic
 * if the chat has taught nothing.
 */
export function looksLikeExpenseForChat(chatId: number, text: string): boolean {
  if (looksLikeExpense(text)) return true;
  if (!/\d/.test(text)) return false;
  const terms = getExpenseTerms(chatId);
  if (terms.length === 0) return false;
  const lower = text.toLowerCase();
  return terms.some((t) => lower.includes(t));
}

/**
 * Should a reply be kept AWAY from the tone-only humorizer (OpenAI)? Money is
 * never humorized — the rewrite can drop or distort amounts, names and splits,
 * which is unacceptable for expenses. A turn counts as money-context when it
 * came from a receipt photo, the user's message looked like a spend, or the
 * reply itself talks money (e.g. the model answered a receipt in plain text
 * without calling the expense tool). Better to lose a joke than mangle a number.
 */
export function isMoneyContext(args: {
  source: string;
  userText: string;
  replyText: string;
  /** When given, also matches the chat's learned expense dictionary. */
  chatId?: number;
}): boolean {
  if (args.source === 'photo') return true;
  const looksMoney = (t: string): boolean =>
    args.chatId != null ? looksLikeExpenseForChat(args.chatId, t) : looksLikeExpense(t);
  return looksMoney(args.userText) || looksMoney(args.replyText);
}

// Names/nicknames the bot answers to when addressed by name. Cyrillic isn't a
// JS \w char, so \b boundaries don't work here — use letter lookarounds instead.
// "бот" forms are listed explicitly (nominative/vocative) to avoid matching
// inside words like "работа"/"ботинки".
const BOT_NAME =
  /(?<![а-яёa-z])(скай(лер[а-яё]{0,2})?|sky(ler)?|мисс(ис)?\.?\s+вайт|(miss|mrs?)\.?\s+white|ботик[ауе]?|ботяр[ауые]?|бот|bot)(?![а-яёa-z])/i;

// Question / direct-request markers, paired with a bot-name mention below.
const QUESTION_OR_REQUEST =
  /[?？]|(?<![а-яёa-z])(что|чё|как|почему|зачем|когда|где|куда|откуда|сколько|какой|какая|какое|какие|кто|можешь|можно|подскажи|подскажешь|расскажи|расскажешь|напомни|посчитай|скажи|покажи|what|how|why|when|where|who|which|can|could|would|tell|does)(?![а-яёa-z])/i;

/**
 * Does this text address the bot by name with a question or direct request?
 * Voice notes can't @mention or reply, so "Скай, какая погода?" / "бот, напомни
 * …" / "миссис Вайт, посчитай …" should still be treated as addressed. Requires
 * BOTH a name and a question/request marker, so merely talking about the bot
 * ("скай вчера лагал") doesn't trigger it.
 */
export function addressesBotByName(text: string): boolean {
  return BOT_NAME.test(text) && QUESTION_OR_REQUEST.test(text);
}

/** Was the bot directly addressed (DM, @mention, or reply to its message)? */
export function isAddressed(ctx: Context): boolean {
  if (ctx.chat?.type === 'private') return true;

  const msg = ctx.message;
  if (!msg) return false;

  const me = ctx.me;
  if (msg.reply_to_message?.from?.id === me.id) return true;

  const text = msg.text ?? msg.caption ?? '';
  const entities = msg.entities ?? msg.caption_entities ?? [];
  for (const e of entities) {
    if (e.type === 'mention') {
      const mention = text.slice(e.offset, e.offset + e.length);
      if (mention.toLowerCase() === `@${me.username.toLowerCase()}`) return true;
    }
    if (e.type === 'text_mention' && e.user?.id === me.id) return true;
  }
  return false;
}

export type RouteDecision = 'process' | 'auto-expense' | 'ignore';

/**
 * Decide how to handle an incoming text/caption message in a configured chat.
 * - DM / addressed → process (the assistant decides expense vs chat).
 * - Group, not addressed, looks like a spend → auto-expense (act only if the
 *   assistant returns an expense; otherwise stay silent).
 * - Otherwise ignore.
 */
export function routeMessage(ctx: Context, text: string): RouteDecision {
  if (isAddressed(ctx)) return 'process';
  const chatId = ctx.chat?.id;
  const isExpense =
    chatId != null ? looksLikeExpenseForChat(chatId, text) : looksLikeExpense(text);
  if (isExpense) return 'auto-expense';
  return 'ignore';
}
