import type { Context } from 'grammy';
import {
  DEFAULT_PING_LIST,
  addPingMembers,
  removePingMembers,
  getPingList,
  listPingLists,
  clearPingList,
} from '../../db/repos/pingList.repo.js';
import { generatePingLesson, pingLessonPhrase } from '../../llm/pingLesson.js';
import { getRecentChat } from '../recentChat.js';

// Re-exported for convenience/tests: the canned pool lives in llm/pingLesson.ts
// (it doubles as the prompt's tone references there).
export { PING_LESSONS, pingLessonPhrase } from '../../llm/pingLesson.js';

/**
 * `/ping` — the roll call. Pings a named circle of people from the chat:
 *   /ping                      — ping the default list («dota» — набор для доты)
 *   /ping <список>             — ping a named list
 *   /ping show [список]        — DRY RUN: show a roster without pinging anyone
 *   /ping add [список] @а @б   — add members (creates the list; default list if omitted)
 *   /ping del [список] @а      — remove members
 *   /ping lists                — show every list with its members (no pings)
 *   /ping clear [список]       — drop a whole list
 * Russian aliases work too: добавь/удали/убери/списки/очисть/состав/кто.
 * The roster can also be edited in plain words via the assistant («добавь @vasya
 * в основной пинг») — that routes through the `edit_ping_list` tool.
 *
 * The ping itself is DETERMINISTIC (no LLM): a ping must fire instantly and
 * reliably, so the persona flavor comes from a canned call-to-arms phrase, and
 * plain-text @usernames do the actual notifying. Right after the roll call a
 * SECOND message drops a nonsense "lesson" from the schoolkid-sensei — that one
 * IS generated (riffing on the chat's recent messages, with the canned pool as
 * tone references), falling back to a canned lesson if the model is unavailable.
 */

// Call-to-arms openers in the schoolkid-dota-teacher voice. One is picked at
// random for each ping so the roll call doesn't go stale.
export const PING_CALLS: readonly string[] = [
  'Так, класс, урок доты начинается! Все в сбор:',
  'Собрание секции по доте, явка обязательна. Опоздавшим — реплеи моих каток:',
  'Ну что, ученички, время практики. Мид не занимать, я покажу как надо:',
  'Домашка по доте сама себя не сыграет. Го, я всё объясню:',
  'Внимание, лекция «как не руинить» начнётся с минуты на минуту. Присутствуют:',
  'Погнали катать! Кто не придёт — тому конспект по вардам переписывать:',
];

export function pingCallPhrase(rand: () => number = Math.random): string {
  return PING_CALLS[Math.floor(rand() * PING_CALLS.length)]!;
}

/**
 * Make a member token display-safe: an @username in a sent message would ping.
 * A zero-width space (U+200B) after the @ keeps the text readable but breaks
 * Telegram's mention parsing, so rosters can be VIEWED (lists/show) without
 * notifying anyone.
 */
export function defangMention(member: string): string {
  return member.startsWith('@') ? '@\u200b' + member.slice(1) : member;
}

function argsOf(ctx: Context): string {
  return ((ctx.match as string | undefined) ?? '').trim();
}

const ADD_ALIASES = new Set(['add', 'добавь', 'добавить']);
const DEL_ALIASES = new Set(['del', 'remove', 'rm', 'удали', 'удалить', 'убери']);
const LIST_ALIASES = new Set(['lists', 'list', 'списки', 'список']);
const SHOW_ALIASES = new Set(['show', 'who', 'состав', 'кто']);
const CLEAR_ALIASES = new Set(['clear', 'очисть', 'очисти', 'очистить']);

/**
 * Split subcommand tokens into [listName, members]: the first token is a list
 * name only when it doesn't look like a member (@…) AND more tokens follow —
 * so «/ping add @вася» targets the default list, «/ping add стак @вася» the
 * «стак» list, and «/ping add вася» adds a plain-text «вася» to the default.
 */
function splitListAndMembers(tokens: string[]): { list: string; members: string[] } {
  const [first, ...rest] = tokens;
  if (first && !first.startsWith('@') && rest.length > 0) {
    return { list: first, members: rest };
  }
  return { list: DEFAULT_PING_LIST, members: tokens };
}

const USAGE =
  'Как пользоваться:\n' +
  '/ping — пингануть основной состав\n' +
  '/ping <список> — пингануть другой список\n' +
  '/ping show [список] — посмотреть состав БЕЗ пинга\n' +
  '/ping add [список] @ник … — добавить в список\n' +
  '/ping del [список] @ник … — убрать из списка\n' +
  '/ping lists — все списки\n' +
  '/ping clear [список] — удалить список целиком\n' +
  'Можно и словами: «добавь @ника в основной пинг», «убери @васю из пинга».';

export async function cmdPing(ctx: Context): Promise<void> {
  if (!ctx.chat || !ctx.from) return;
  const chatId = ctx.chat.id;
  const raw = argsOf(ctx);
  const tokens = raw.length > 0 ? raw.split(/\s+/) : [];
  const sub = (tokens[0] ?? '').toLowerCase();

  if (ADD_ALIASES.has(sub)) {
    const { list, members } = splitListAndMembers(tokens.slice(1));
    if (members.length === 0) {
      await ctx.reply('Кого добавлять-то? /ping add [список] @ник …');
      return;
    }
    const added = addPingMembers(chatId, list, members, ctx.from.id);
    const roster = getPingList(chatId, list);
    await ctx.reply(
      added.length > 0
        ? `Записал в состав «${list}»: ${added.map(defangMention).join(' ')}. Теперь нас ${roster.length}. Проверка связи: /ping${list === DEFAULT_PING_LIST ? '' : ` ${list}`}`
        : `Эти и так в составе «${list}» — я всех своих учеников помню.`,
    );
    return;
  }

  if (DEL_ALIASES.has(sub)) {
    const { list, members } = splitListAndMembers(tokens.slice(1));
    if (members.length === 0) {
      await ctx.reply('Кого отчисляем? /ping del [список] @ник …');
      return;
    }
    const removed = removePingMembers(chatId, list, members);
    await ctx.reply(
      removed.length > 0
        ? `Отчислил из «${list}»: ${removed.map(defangMention).join(' ')}. Меньше народу — больше фрагов.`
        : `Таких в списке «${list}» нет. Кто есть: /ping lists`,
    );
    return;
  }

  if (LIST_ALIASES.has(sub) && tokens.length === 1) {
    const lists = listPingLists(chatId);
    if (lists.length === 0) {
      await ctx.reply(`Списков пока нет. Заводи первый: /ping add @ник …`);
      return;
    }
    const lines = lists.map(
      (l) => `• ${l.name} (${l.members.length}): ${l.members.map(defangMention).join(' ')}`,
    );
    await ctx.reply(
      `Мои журналы посещаемости (никого не пингую, просто показываю):\n${lines.join('\n')}`,
    );
    return;
  }

  // Dry run: show one roster without pinging anyone (mentions are defanged).
  if (SHOW_ALIASES.has(sub)) {
    const list = tokens[1] ?? DEFAULT_PING_LIST;
    const members = getPingList(chatId, list);
    if (members.length === 0) {
      await ctx.reply(
        `Состав «${list}» пуст. Набрать: /ping add${list === DEFAULT_PING_LIST ? '' : ` ${list}`} @ник …`,
      );
      return;
    }
    await ctx.reply(
      `Состав «${list}» (${members.length}), без пинга:\n${members.map(defangMention).join(' ')}`,
    );
    return;
  }

  if (CLEAR_ALIASES.has(sub)) {
    const list = tokens[1] ?? DEFAULT_PING_LIST;
    const n = clearPingList(chatId, list);
    await ctx.reply(
      n > 0
        ? `Список «${list}» расформирован (${n} чел.). Класс распущен.`
        : `Списка «${list}» и не было. Смотри что есть: /ping lists`,
    );
    return;
  }

  // No subcommand → this is the ping itself: /ping or /ping <список>.
  if (tokens.length > 1) {
    await ctx.reply(USAGE);
    return;
  }
  const list = tokens[0] ?? DEFAULT_PING_LIST;
  const members = getPingList(chatId, list);
  if (members.length === 0) {
    await ctx.reply(
      `Состав «${list}» пуст — некого учить. Набери учеников: /ping add${list === DEFAULT_PING_LIST ? '' : ` ${list}`} @ник …\n\n${USAGE}`,
    );
    return;
  }
  // Plain text so Telegram turns @usernames into real pings.
  await ctx.reply(`${pingCallPhrase()}\n${members.join(' ')}`);
  // The follow-up "lesson" is a separate message so the ping stays clean and the
  // joke lands on its own. It's generated off the chat's recent chatter (the same
  // in-memory buffer the chime uses); a canned lesson covers any model failure.
  // Best-effort throughout: a failed second send must not undo the ping.
  let lesson: string | null = null;
  try {
    lesson = await generatePingLesson(getRecentChat(chatId));
  } catch {
    lesson = null; // generator failures fall back to the canned pool below
  }
  try {
    await ctx.reply(lesson ?? pingLessonPhrase());
  } catch {
    /* the ping already went out — the lesson is a bonus */
  }
}
