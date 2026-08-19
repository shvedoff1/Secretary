import type { ChatMode } from './db/repos/chatSettings.repo.js';

/**
 * The chat modes, in one place: their labels, what they're for, and which of the
 * "personality" features they allow. Everything user-facing about a mode (the
 * picker keyboard, /modes, /mode, /chat, the greeting posted after a pick) is
 * rendered from THIS list, so adding a mode is one entry here plus its system
 * prompt — not a dozen `Record<ChatMode, …>` maps that drift apart.
 *
 * The feature flags below are the MODE's own stance ("a calm assistant doesn't
 * crack jokes"); the per-chat switches (/humor, /chime, /react, /slang) still
 * apply on top, and both must allow a feature for it to run.
 */
export interface ModeSpec {
  mode: ChatMode;
  /** One-character code used in the picker's callback data (`m:<code>:<chatId>`). */
  code: string;
  /** Short label with emoji, e.g. for buttons and one-line status. */
  label: string;
  /** What this mode is for — shown in the picker's "что за режимы" card and /modes. */
  description: string;
  /** What the bot says in the chat right after this mode is picked. */
  greeting: string;
  /** OpenAI humour pass (jokes) — the tone rewrite, humour tasks, expense quips. */
  humor: boolean;
  /** Apply the chat's learned slang (vocabulary-only pass + humorizer lexicon). */
  slang: boolean;
  /** Spontaneous chime-ins into a silent chat. */
  chime: boolean;
  /** Random positive emoji auto-reactions. */
  reactions: boolean;
}

export const MODES: ModeSpec[] = [
  {
    mode: 'secretary',
    code: 's',
    label: '🤙 секретарь',
    description:
      'Секретарь-сёрфер: всё умеет (траты, напоминания, память, поиск, места, вотчеры) и делает это с характером — шутит, подкалывает, вбрасывает в тишину. Дефолт.',
    greeting: 'Йоу, я на связи! Чем могу — /help. 🤙',
    humor: true,
    slang: true,
    chime: true,
    reactions: true,
  },
  {
    mode: 'assistant',
    code: 'a',
    label: '🧠 ассистент',
    description:
      'Спокойный помощник без характера: те же умения, что у секретаря, но без шуток, вбросов и реакций. Подстраивается под чат — помнит и говорит вашими словами. Поведение задаётся правилами: «все голосовые очищай от слов-паразитов и скидывай расшифровку» (/rules).',
    greeting:
      'Привет, я на связи. Умею напоминания, память, поиск, траты — /help. Правила поведения задаются просто словами («с этого момента …») или командой /rules.',
    humor: false,
    slang: true,
    chime: false,
    reactions: false,
  },
  {
    mode: 'dota',
    code: 'd',
    label: '🎮 дота',
    description:
      'Всё то же, что у секретаря, но персона — школьник-«сенсей» по Dota 2: разбирает катки, сыпет советами. Плюс база по текущему патчу (/dota) и сбор пати через /ping.',
    greeting:
      'Так, класс, ваш учитель по доте на месте. Записывайтесь на урок: /ping add @ник …, сбор — /ping. Опоздавших отмечаю в журнале.',
    humor: true,
    slang: true,
    chime: true,
    reactions: true,
  },
  {
    mode: 'tutor',
    code: 't',
    label: '🎓 репетитор',
    description:
      'Подготовка к ОГЭ за 9 класс: решает пошагово и перепроверяет себя. Без сленга, шуток, вбросов и реакций; из умений — память, напоминания и поиск. Фото = задача, а не чек.',
    greeting: 'Привет! Я репетитор. Присылай задачу — разберём по шагам.',
    humor: false,
    slang: false,
    chime: false,
    reactions: false,
  },
];

const BY_MODE = new Map<ChatMode, ModeSpec>(MODES.map((m) => [m.mode, m]));
const BY_CODE = new Map<string, ModeSpec>(MODES.map((m) => [m.code, m]));

export function modeSpec(mode: ChatMode): ModeSpec {
  // Every ChatMode has an entry (enforced by the type + a test); fall back to the
  // default rather than throwing inside a message handler.
  return BY_MODE.get(mode) ?? BY_MODE.get('secretary')!;
}

export function modeByCode(code: string): ModeSpec | null {
  return BY_CODE.get(code) ?? null;
}

/** Parse a mode written by a human («assistant», «ассистент») — null if unknown. */
export function parseMode(raw: string): ChatMode | null {
  const s = raw.trim().toLowerCase();
  const alias: Record<string, ChatMode> = {
    secretary: 'secretary',
    секретарь: 'secretary',
    assistant: 'assistant',
    ассистент: 'assistant',
    помощник: 'assistant',
    dota: 'dota',
    дота: 'dota',
    tutor: 'tutor',
    репетитор: 'tutor',
  };
  return alias[s] ?? null;
}

/** `tutor|secretary|assistant|dota` — for usage strings, built from the list. */
export const MODE_NAMES = MODES.map((m) => m.mode).join('|');

export function modeAllowsHumor(mode: ChatMode): boolean {
  return modeSpec(mode).humor;
}

export function modeAllowsSlang(mode: ChatMode): boolean {
  return modeSpec(mode).slang;
}

export function modeAllowsChime(mode: ChatMode): boolean {
  return modeSpec(mode).chime;
}

export function modeAllowsReactions(mode: ChatMode): boolean {
  return modeSpec(mode).reactions;
}

/** The «что за режимы?» card: every mode with what it's for. */
export function renderModeCard(): string {
  return MODES.map((m) => `${m.label} — ${m.description}`).join('\n\n');
}
