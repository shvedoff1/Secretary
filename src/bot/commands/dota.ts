import type { Context } from 'grammy';
import {
  DEFAULT_PING_LIST,
  addPingMembers,
  removePingMembers,
  getPingList,
  listPingLists,
  clearPingList,
} from '../../db/repos/pingList.repo.js';

/**
 * `/dota` — the roll call. Pings a named circle of people from the chat:
 *   /dota                      — ping the default list («dota»)
 *   /dota <список>             — ping a named list
 *   /dota add [список] @а @б   — add members (creates the list; default list if omitted)
 *   /dota del [список] @а      — remove members
 *   /dota lists                — show every list with its members
 *   /dota clear [список]       — drop a whole list
 * Russian aliases work too: добавь/удали/списки/очисть.
 *
 * The ping itself is DETERMINISTIC (no LLM): a ping must fire instantly and
 * reliably, so the persona flavor comes from a canned call-to-arms phrase, and
 * plain-text @usernames do the actual notifying.
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

function argsOf(ctx: Context): string {
  return ((ctx.match as string | undefined) ?? '').trim();
}

const ADD_ALIASES = new Set(['add', 'добавь', 'добавить']);
const DEL_ALIASES = new Set(['del', 'remove', 'rm', 'удали', 'удалить']);
const LIST_ALIASES = new Set(['lists', 'list', 'списки', 'список']);
const CLEAR_ALIASES = new Set(['clear', 'очисть', 'очисти', 'очистить']);

/**
 * Split subcommand tokens into [listName, members]: the first token is a list
 * name only when it doesn't look like a member (@…) AND more tokens follow —
 * so «/dota add @вася» targets the default list, «/dota add стак @вася» the
 * «стак» list, and «/dota add вася» adds a plain-text «вася» to the default.
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
  '/dota — пингануть основной состав\n' +
  '/dota <список> — пингануть другой список\n' +
  '/dota add [список] @ник … — добавить в список\n' +
  '/dota del [список] @ник … — убрать из списка\n' +
  '/dota lists — все списки\n' +
  '/dota clear [список] — удалить список целиком';

export async function cmdDota(ctx: Context): Promise<void> {
  if (!ctx.chat || !ctx.from) return;
  const chatId = ctx.chat.id;
  const raw = argsOf(ctx);
  const tokens = raw.length > 0 ? raw.split(/\s+/) : [];
  const sub = (tokens[0] ?? '').toLowerCase();

  if (ADD_ALIASES.has(sub)) {
    const { list, members } = splitListAndMembers(tokens.slice(1));
    if (members.length === 0) {
      await ctx.reply('Кого добавлять-то? /dota add [список] @ник …');
      return;
    }
    const added = addPingMembers(chatId, list, members, ctx.from.id);
    const roster = getPingList(chatId, list);
    await ctx.reply(
      added.length > 0
        ? `Записал в состав «${list}»: ${added.join(' ')}. Теперь нас ${roster.length}. Проверка связи: /dota${list === DEFAULT_PING_LIST ? '' : ` ${list}`}`
        : `Эти и так в составе «${list}» — я всех своих учеников помню.`,
    );
    return;
  }

  if (DEL_ALIASES.has(sub)) {
    const { list, members } = splitListAndMembers(tokens.slice(1));
    if (members.length === 0) {
      await ctx.reply('Кого отчисляем? /dota del [список] @ник …');
      return;
    }
    const removed = removePingMembers(chatId, list, members);
    await ctx.reply(
      removed.length > 0
        ? `Отчислил из «${list}»: ${removed.join(' ')}. Меньше народу — больше фрагов.`
        : `Таких в списке «${list}» нет. Кто есть: /dota lists`,
    );
    return;
  }

  if (LIST_ALIASES.has(sub) && tokens.length === 1) {
    const lists = listPingLists(chatId);
    if (lists.length === 0) {
      await ctx.reply(`Списков пока нет. Заводи первый: /dota add @ник …`);
      return;
    }
    const lines = lists.map((l) => `• ${l.name} (${l.members.length}): ${l.members.join(' ')}`);
    await ctx.reply(`Мои журналы посещаемости:\n${lines.join('\n')}`);
    return;
  }

  if (CLEAR_ALIASES.has(sub)) {
    const list = tokens[1] ?? DEFAULT_PING_LIST;
    const n = clearPingList(chatId, list);
    await ctx.reply(
      n > 0
        ? `Список «${list}» расформирован (${n} чел.). Класс распущен.`
        : `Списка «${list}» и не было. Смотри что есть: /dota lists`,
    );
    return;
  }

  // No subcommand → this is the ping itself: /dota or /dota <список>.
  if (tokens.length > 1) {
    await ctx.reply(USAGE);
    return;
  }
  const list = tokens[0] ?? DEFAULT_PING_LIST;
  const members = getPingList(chatId, list);
  if (members.length === 0) {
    await ctx.reply(
      `Состав «${list}» пуст — некого учить. Набери учеников: /dota add${list === DEFAULT_PING_LIST ? '' : ` ${list}`} @ник …\n\n${USAGE}`,
    );
    return;
  }
  // Plain text so Telegram turns @usernames into real pings.
  await ctx.reply(`${pingCallPhrase()}\n${members.join(' ')}`);
}
