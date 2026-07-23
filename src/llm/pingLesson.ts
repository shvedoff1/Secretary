import type Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { getAnthropic } from './client.js';

/**
 * The nonsense "lesson" that follows the /ping roll call as a separate message.
 * It is GENERATED per ping so it can riff on what the chat was just talking
 * about; the canned pool below serves as tone references inside the prompt AND
 * as the deterministic fallback when the model is unavailable — the roll call
 * must never lose its punchline to an API error.
 */
export const PING_LESSONS: readonly string[] = [
  'Урок №1: если мид проигран — это не ты слил, это крипы предали. Записываем.',
  'Конспектируем: вард, поставленный с закрытыми глазами, даёт скрытый обзор. Проверено мной, а я учитель.',
  'Тема урока: тащить катку силой мысли. Кто не тащит — тот просто недостаточно думает.',
  'Запомните, дети: курьера убивать нельзя. Но если очень хочется — это называется «макро».',
  'Лекция: байт на смерть — это стратегия. Просто смерть — тоже байт, но более глубокий.',
  'Урок геометрии: хук Пуджа летит по прямой, если верить. Вера — главный стат после силы.',
  'Записываем в тетрадь: если купить вард и не поставить — обзор копится на депозите. Экономика, 5 класс.',
  'Тема: как не тильтовать. Ответ: тильтуй первым, пока не начали остальные. Инициатива — половина победы.',
  'Помните: Рошан — это не цель, это состояние души. Кто понял — тому пятёрка в четверти.',
  'Домашнее задание: проиграть лайн настолько уверенно, чтобы враг решил, что это план.',
  'Минутка теории: пауза в игре лечит. Не тиммейтов, конечно, но нервы — точно.',
  'Открытый урок: «гг» пишется в конце. Кто пишет в начале — останется после уроков смотреть свои реплеи.',
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
  `- Одно-два предложения, как в примерах ниже. Никаких вступлений, пояснений или ` +
  `кавычек — только сам урок.\n` +
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
 * Generate the post-ping lesson with the main model, riffing on the chat's
 * recent messages. Best-effort: any failure (no key, API error, empty output)
 * returns null and the caller falls back to {@link pingLessonPhrase} — the
 * lesson may never delay or break the ping flow beyond one bounded call.
 * Any stray @ in the output is defanged so the lesson can't ping anyone.
 */
export async function generatePingLesson(
  recent: LessonContextLine[],
): Promise<string | null> {
  const cfg = loadConfig();
  const lines = recent.map((r) => `${r.name}: ${r.text}`).join('\n');
  const userContent = lines
    ? `Последние сообщения чата:\n${lines}`
    : 'В чате тихо, свежих сообщений нет — урок без привязки.';
  try {
    const res = await getAnthropic().messages.create({
      model: cfg.ANTHROPIC_MODEL,
      max_tokens: 300,
      // Keep the same snappy no-thinking behaviour as the main assistant call —
      // on Sonnet 5 adaptive thinking would turn ON if `thinking` were omitted.
      thinking: { type: 'disabled' },
      system: [{ type: 'text', text: LESSON_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userContent }],
    });
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    if (!text) return null;
    // Belt and braces: the prompt forbids @mentions, but a stray one would ping.
    return text.replace(/@/g, '@\u200b');
  } catch (err) {
    logger.warn({ err }, 'ping lesson generation failed, falling back to canned');
    return null;
  }
}
