import type { Context } from 'grammy';
import { loadConfig } from '../../config.js';
import {
  addRule,
  clearRules,
  listRules,
  removeRule,
} from '../../db/repos/chatRule.repo.js';
import { isAdmin } from '../../db/repos/users.repo.js';
import { replyLong } from '../../util/telegramText.js';

/**
 * Split the argument string into an optional leading chat id and the rest — the
 * same shape as /slang, so an admin can manage another chat's rules from the DM
 * («/rules -100123 add …») while a plain «/rules add …» targets the current chat.
 * A rule text may itself start with a number, so only a LEADING integer followed
 * by a known sub-command (or nothing) is read as a chat id.
 */
export function parseRulesArgs(raw: string): { chatId: number | null; rest: string } {
  const trimmed = raw.trim();
  const m = /^(-?\d+)\b\s*([\s\S]*)$/.exec(trimmed);
  if (m) {
    const id = Number(m[1]);
    const rest = m[2]!.trim();
    const head = rest.split(/\s+/)[0]?.toLowerCase() ?? '';
    const isSubcommand = rest === '' || ADD.has(head) || DEL.has(head) || CLEAR.has(head);
    if (Number.isInteger(id) && id !== 0 && isSubcommand) {
      return { chatId: id, rest };
    }
  }
  return { chatId: null, rest: trimmed };
}

const ADD = new Set(['add', 'добавь', 'добавить', '+']);
const DEL = new Set(['del', 'delete', 'rm', 'удали', 'удалить', '-']);
const CLEAR = new Set(['clear', 'reset', 'очистить', 'сброс']);

/**
 * `/rules` — the chat's standing behaviour rules: what the bot must do here in
 * EVERY reply («все голосовые очищай от слов-паразитов и скидывай расшифровку»,
 * «отвечай короче», «без эмодзи»). They are injected into every turn as orders,
 * which is what makes them different from /memory (facts the bot knows).
 *
 * `/rules add <текст>` · `/rules del <N>` · `/rules clear`. The same rules can be
 * set by just telling the bot («с этого момента …» → the `set_rule` tool); this
 * command is the explicit list-and-edit view.
 *
 * Admins can target another chat from the DM: `/rules <chatId> …`.
 */
export async function cmdRules(ctx: Context): Promise<void> {
  if (!ctx.chat) return;
  const { chatId, rest } = parseRulesArgs((ctx.match as string | undefined) ?? '');

  const targetId = chatId ?? ctx.chat.id;
  // Reading/editing another chat's rules from here would leak (and change) how the
  // bot behaves elsewhere — admin only, exactly like /slang <chatId>.
  if (chatId !== null && chatId !== ctx.chat.id && !isAdmin(ctx.from?.id ?? 0)) {
    await ctx.reply('Чужой чат по id смотрит только администратор.');
    return;
  }
  const forOther = targetId !== ctx.chat.id;
  const idArg = forOther ? `${targetId} ` : '';

  const [head = '', ...tail] = rest.split(/\s+/);
  const verb = head.toLowerCase();
  const body = rest.slice(head.length).trim();

  if (ADD.has(verb)) {
    if (!body) {
      await ctx.reply(
        `Что записать? Например: /rules ${idArg}add Все голосовые расшифровывай, ` +
          `чисти от слов-паразитов и присылай расшифровку`,
      );
      return;
    }
    const res = addRule({
      chatId: targetId,
      text: body,
      tgUserId: ctx.from?.id ?? null,
      max: loadConfig().CHAT_RULES_MAX,
    });
    if (res.status === 'duplicate') {
      await ctx.reply(`Такое правило уже есть: «${res.rule.text}».`);
      return;
    }
    if (res.status === 'full') {
      await ctx.reply(
        `Правил уже ${res.max} — это максимум (они уходят в каждый запрос). ` +
          `Удали лишнее: /rules ${idArg}del <N>`,
      );
      return;
    }
    await ctx.reply(`✅ Правило записано: «${res.rule.text}»\nВсе правила: /rules ${idArg}`.trim());
    return;
  }

  if (DEL.has(verb)) {
    const n = Number(tail[0]);
    const rules = listRules(targetId);
    if (!Number.isInteger(n) || n < 1 || n > rules.length) {
      await ctx.reply(`Использование: /rules ${idArg}del <номер из /rules ${idArg}>`.trim());
      return;
    }
    const removed = removeRule(targetId, rules[n - 1]!.id);
    await ctx.reply(removed ? `🗑️ Убрал: «${removed}»` : 'Такого правила уже нет.');
    return;
  }

  if (CLEAR.has(verb)) {
    const n = clearRules(targetId);
    await ctx.reply(
      n > 0
        ? `🧹 Правила ${forOther ? `чата ${targetId} ` : ''}очищены (было ${n}).`
        : 'Правил и так не было.',
    );
    return;
  }

  const rules = listRules(targetId);
  if (rules.length === 0) {
    await ctx.reply(
      `Правил пока нет. Правило — это как мне себя вести в этом чате постоянно, ` +
        `например:\n/rules ${idArg}add Все голосовые расшифровывай, чисти от ` +
        `слов-паразитов и присылай расшифровку\n\n` +
        `Можно и просто сказать словами: «с этого момента …» — запишу сам.`,
    );
    return;
  }
  const lines = rules.map((r, i) => `${i + 1}. ${r.text}`);
  const header = forOther ? `📋 Правила чата ${targetId}:` : '📋 Правила этого чата:';
  await replyLong(
    ctx,
    `${header}\n${lines.join('\n')}\n\n` +
      `Добавить: /rules ${idArg}add <текст> · убрать: /rules ${idArg}del <N> · ` +
      `очистить: /rules ${idArg}clear`,
  );
}
