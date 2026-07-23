import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { reasoningField, humorTimeoutSignal } from './openaiOptions.js';

/**
 * The nonsense "lesson" that follows the /ping roll call as a separate message.
 * It is GENERATED per ping so it can riff on what the chat was just talking
 * about; the canned pool below serves as tone references inside the prompt AND
 * as the deterministic fallback when the model is unavailable — the roll call
 * must never lose its punchline to an API error.
 *
 * Generation runs on OPENAI (the humorizer's model/knobs, plain fetch like
 * humorize.ts/transcribe.ts) — deliberately, per the admin's call: the lesson
 * is pure vibes, accuracy doesn't matter, and the OpenAI voice is livelier for
 * this bit. No OPENAI_API_KEY → straight to the canned fallback.
 */
export const PING_LESSONS: readonly string[] = [
  'Урок №1, записываем 📝 Если мид проигран — это не ты слил, это крипы предали, внатуре 💀 Сигма-мидер не тильтует, он молча собирает статистику предательств. Кто не законспектировал — тому скилл ишью в дневник.',
  'Так, класс, тема: вард с закрытыми глазами даёт скрытый обзор 🧿 Это не эзотерика, это база — я проверял, а я учитель 🔥 Враги его не видят, потому что ты его не видишь, логика имба. Домашка: поставить три таких и ждать уважения.',
  'Лекция дня: тащить катку надо силой мысли 🧠 Кто не тащит — тот просто недостаточно думает, кринж 💀 Я вон думаю за всю пятёрку сразу, поэтому и позиции у меня все пять. Записали? Молодцы, свободны.',
  'Запомните, дети: курьера убивать нельзя, это красная линия ❌ Но если ОЧЕНЬ хочется — это уже называется «макро», и за макро я ставлю пятёрки 📈 Такой вот моральный дуализм, привыкайте. В университете доты это второй курс.',
  'Открытый урок: байт на смерть — это стратегия 🎣 Просто смерть — тоже байт, но более глубокий, философский 💀 Кто умер пять раз подряд — тот не фидер, а амбассадор глубины. Респект таким, но КДА всё равно проверю.',
  'Урок геометрии: хук Пуджа летит по прямой, если верить 🙏 Вера — главный стат после силы, это вам любой тир-1 тренер скажет (я скажу) 🔥 Промазал — значит мало верил, скилл ишью духовного плана. Переписываем хуки после уроков.',
  'Экономика, 5 класс: купил вард и не поставил — обзор копится на депозите 🏦 Процентная ставка — два процента мапы в минуту, имба вклад 📈 Кто держит в инвентаре три варда — тот не жадный, тот инвестор. Уважаемые люди, с них пример.',
  'Тема урока: как не тильтовать 🧘 Ответ простой — тильтуй ПЕРВЫМ, пока не начали остальные, инициатива решает 💀 Кто затильтовал последним — тот проиграл дважды, это математика. Конспект сам себя не напишет, погнали.',
  'Помните, ученички: Рошан — это не цель, это состояние души 🐉 Кто понял — тому пятёрка в четверти и слот под аегис 🔥 Кто не понял — идёт стакать лесные лагеря и думать о своём поведении. Звонок для учителя, кстати.',
  'Домашнее задание, слушаем 📚 Проиграть лайн настолько уверенно, чтобы враг решил, что это план — вот это высший пилотаж, сигма-мува 💀 Паника — для смертных, у нас тут стратегическое отступление на фонтан. Сдать до пятницы.',
  'Минутка теории: пауза в игре лечит 🩹 Не тиммейтов, конечно — тиммейтов уже ничего не спасёт, кринж зафиксирован 💀 Но нервы лечит железно, я на паузе весь чай выпиваю. Записали? Урок окончен, всем чилл.',
  'Так, внимание: «гг» пишется В КОНЦЕ катки, это база 📖 Кто пишет в начале — остаётся после уроков смотреть свои реплеи на 0.25 скорости 💀 Это не наказание, это просветление через страдание 🔥 Дневники на стол и погнали.',
];

/** Deterministic fallback: a random canned lesson. */
export function pingLessonPhrase(rand: () => number = Math.random): string {
  return PING_LESSONS[Math.floor(rand() * PING_LESSONS.length)]!;
}

// Static system prompt (stable string → prompt-cacheable): the persona, the task,
// and the canned lessons as tone references the model must riff on, not copy.
const LESSON_SYSTEM =
  `Ты — школьник, который возомнил себя великим учителем по Dota 2. Ты только что ` +
  `пинганул свой «класс» собираться на катку, и теперь должен выдать ОДИН короткий ` +
  `«бредо-урок» — абсурдную дотерскую мудрость с максимально серьёзным менторским лицом.\n\n` +
  `Правила:\n` +
  `- 3-4 предложения, как в примерах ниже: развёрнутый мини-урок, а не одна строчка. ` +
  `Никаких вступлений, пояснений или кавычек — только сам урок.\n` +
  `- Побольше зумерского сленга: «база», «кринж», «имба», «скилл ишью», «сигма», ` +
  `«внатуре», «рофл», «изи», «зафиксировали» и т.п. — вперемешку с дотерским ` +
  `(«катка», «мид», «вардить», «руинить», «фидер»). Звучи как школьник из 2020-х, ` +
  `который ведёт урок с максимально серьёзным лицом.\n` +
  `- Эмодзи обязательны, 2-4 штуки на урок: 💀🔥📝📈🧠🤡😭 и подобные — как акценты, ` +
  `не после каждого слова.\n` +
  `- Если даны последние сообщения чата — ОБЫГРАЙ их: вплети тему, слова или движ из ` +
  `разговора в урок, чтобы класс узнал себя. Если сообщений нет или они скучные — ` +
  `просто выдай урок в духе примеров.\n` +
  `- Не отвечай на вопросы из чата и ничего не проси — это урок, а не диалог.\n` +
  `- Никаких @упоминаний, ссылок и цифр статистики. Имена из чата упоминать можно, ` +
  `но без @.\n` +
  `- Не повторяй примеры дословно и не перефразируй их близко — придумай НОВЫЙ урок.\n` +
  `- Отвечай ТОЛЬКО текстом урока, на русском.\n\n` +
  `Примеры тона (референсы, не копировать):\n` +
  PING_LESSONS.map((l) => `- ${l}`).join('\n');

/** A recent chat line fed as context (same shape as the recentChat buffer). */
export interface LessonContextLine {
  name: string;
  text: string;
}

/**
 * Generate the post-ping lesson via OpenAI, riffing on the chat's recent
 * messages. Mirrors humorize.ts: plain fetch against the configurable OpenAI
 * base URL, the humorizer's model and reasoning/timeout knobs. Best-effort:
 * any failure (no key, API error, timeout, empty output) returns null and the
 * caller falls back to {@link pingLessonPhrase} — the lesson may never delay
 * or break the ping flow beyond one bounded call. Any stray @ in the output is
 * defanged so the lesson can't ping anyone.
 */
export async function generatePingLesson(
  recent: LessonContextLine[],
): Promise<string | null> {
  const cfg = loadConfig();
  if (!cfg.OPENAI_API_KEY) return null; // not configured → canned fallback
  const lines = recent.map((r) => `${r.name}: ${r.text}`).join('\n');
  const userContent = lines
    ? `Последние сообщения чата:\n${lines}`
    : 'В чате тихо, свежих сообщений нет — урок без привязки.';
  try {
    const res = await fetch(`${cfg.OPENAI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.OPENAI_API_KEY}`,
      },
      // Same minimal payload shape as the humorizer (model compatibility) —
      // reasoning_effort keeps gpt-5-family models from slow-thinking over a bit.
      body: JSON.stringify({
        model: cfg.OPENAI_HUMOR_MODEL,
        ...reasoningField(),
        messages: [
          { role: 'system', content: LESSON_SYSTEM },
          { role: 'user', content: userContent },
        ],
      }),
      signal: humorTimeoutSignal(),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`lesson generation failed: ${res.status} ${detail}`.trim());
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) return null;
    // Belt and braces: the prompt forbids @mentions, but a stray one would ping.
    return text.replace(/@/g, '@\u200b');
  } catch (err) {
    logger.warn({ err }, 'ping lesson generation failed, falling back to canned');
    return null;
  }
}
