import {
  type ChatMode,
  getChatMode,
  getPersonaPrompt,
  isChatHumorEnabled,
  isChatSlangEnabled,
  isChimeEnabled,
  isReactionsEnabled,
  setChatHumorEnabled,
  setChatSlangEnabled,
  setChimeEnabled,
  setReactionsEnabled,
} from './db/repos/chatSettings.repo.js';
import { escapeHtml } from './util/telegramHtml.js';

/**
 * The PERSONALITY PRESETS, in one place: their names, what they're for, and the
 * tone-feature defaults they ship with. Everything user-facing about a preset
 * (the picker keyboard, /modes, /mode, /chat, the greeting posted after a pick,
 * the behaviour setup card) is rendered from THIS list, so adding a preset is one
 * entry here plus its system prompt — not a dozen `Record<ChatMode, …>` maps that
 * drift apart.
 *
 * `defaults` are the preset's tone stances ("a calm assistant doesn't crack
 * jokes"). They are DEFAULTS, not gates: picking a preset WRITES them into the
 * chat's own switches (/humor, /slang, /chime, /react via
 * {@link applyModeDefaults}), and from then on the switches alone decide — so an
 * admin can, say, keep the calm voice but turn the chime back on. The one
 * structural exception is the tutor (`toneLocked`): accuracy is its whole point,
 * so no switch can bring jokes/slang/chime/reactions into a study room.
 */
export interface ModeSpec {
  mode: ChatMode;
  /** One-character code used in the picker's callback data (`m:<code>:<chatId>`). */
  code: string;
  /** Canonical user-facing name (what /mode accepts alongside the stored key). */
  name: string;
  /** Short label with emoji, e.g. for buttons and one-line status. */
  label: string;
  /** What this preset is for — shown in the picker's "что за режимы" card and /modes. */
  description: string;
  /** What the bot says in the chat right after this preset is picked. */
  greeting: string;
  /** Default per-chat switch values applied when the preset is picked. */
  defaults: {
    /** OpenAI humour pass (jokes) — the tone rewrite, humour tasks, expense quips. */
    humor: boolean;
    /** Apply the chat's learned slang (vocabulary-only pass + humorizer lexicon). */
    slang: boolean;
    /** Spontaneous chime-ins into a silent chat. */
    chime: boolean;
    /** Random positive emoji auto-reactions. */
    reactions: boolean;
  };
  /** Tone features are STRUCTURALLY off for this preset, whatever the switches say. */
  toneLocked?: boolean;
}

export const MODES: ModeSpec[] = [
  {
    mode: 'secretary',
    code: 's',
    name: 'surfer',
    label: '🤙 сёрфер',
    description:
      'Секретарь-сёрфер: всё умеет (траты, напоминания, память, поиск, места, вотчеры) и делает это с характером — шутит, подкалывает, вбрасывает в тишину. Дефолт.',
    greeting: 'Йоу, я на связи! Чем могу — /help. 🤙',
    defaults: { humor: true, slang: true, chime: true, reactions: true },
  },
  {
    mode: 'assistant',
    code: 'a',
    name: 'calm',
    label: '🧘 спокойный',
    description:
      'Спокойный ассистент без характера: те же умения, что у сёрфера, но без шуток, вбросов и реакций. Подстраивается под чат — помнит и говорит вашими словами. Поведение задаётся правилами: «все голосовые очищай от слов-паразитов и скидывай расшифровку» (/rules).',
    greeting:
      'Привет, я на связи. Умею напоминания, память, поиск, траты — /help. Правила поведения задаются просто словами («с этого момента …») или командой /rules.',
    defaults: { humor: false, slang: true, chime: false, reactions: false },
  },
  {
    mode: 'funny',
    code: 'f',
    name: 'funny',
    label: '😜 весельчак',
    description:
      'Весельчак: те же умения, что у сёрфера, но без сёрферской темы — просто балагур, который шутит, каламбурит и по-доброму подкалывает. Данные (суммы, даты, факты) при этом не трогает.',
    greeting: 'Всем привет! Я тут теперь и по делам, и по приколам — /help. 😜',
    defaults: { humor: true, slang: true, chime: true, reactions: true },
  },
  {
    mode: 'dota',
    code: 'd',
    label: '🎮 дота',
    name: 'dota',
    description:
      'Всё то же, что у сёрфера, но персона — школьник-«сенсей» по Dota 2: разбирает катки, сыпет советами. Плюс база по текущему патчу (/dota) и сбор пати через /ping.',
    greeting:
      'Так, класс, ваш учитель по доте на месте. Записывайтесь на урок: /ping add @ник …, сбор — /ping. Опоздавших отмечаю в журнале.',
    defaults: { humor: true, slang: true, chime: true, reactions: true },
  },
  {
    mode: 'tutor',
    code: 't',
    name: 'tutor',
    label: '🎓 репетитор',
    description:
      'Подготовка к ОГЭ за 9 класс: решает пошагово и перепроверяет себя. Без сленга, шуток, вбросов и реакций; из умений — память, напоминания и поиск. Фото = задача, а не чек.',
    greeting: 'Привет! Я репетитор. Присылай задачу — разберём по шагам.',
    defaults: { humor: false, slang: false, chime: false, reactions: false },
    toneLocked: true,
  },
  {
    mode: 'custom',
    code: 'c',
    name: 'custom',
    label: '🎨 кастом',
    description:
      'Кастом: характер бота описываешь сам, своими словами — /prompt <chatId> <текст> («ты дворецкий-аристократ, вежлив до занудства»). Все умения на месте; пока описания нет, ведёт себя как спокойный ассистент.',
    greeting: 'Привет, я на связи — /help. Характер мне сейчас настраивают.',
    defaults: { humor: false, slang: true, chime: false, reactions: false },
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

/** Parse a preset written by a human («calm», «спокойный», «assistant») — null if unknown. */
export function parseMode(raw: string): ChatMode | null {
  const s = raw.trim().toLowerCase();
  const alias: Record<string, ChatMode> = {
    // Stored keys stay parseable so old habits (and old docs) keep working.
    secretary: 'secretary',
    секретарь: 'secretary',
    surfer: 'secretary',
    сёрфер: 'secretary',
    серфер: 'secretary',
    assistant: 'assistant',
    ассистент: 'assistant',
    помощник: 'assistant',
    calm: 'assistant',
    спокойный: 'assistant',
    funny: 'funny',
    весельчак: 'funny',
    шутник: 'funny',
    custom: 'custom',
    кастом: 'custom',
    свой: 'custom',
    dota: 'dota',
    дота: 'dota',
    tutor: 'tutor',
    репетитор: 'tutor',
  };
  return alias[s] ?? null;
}

/** `surfer|calm|funny|dota|tutor|custom` — for usage strings, built from the list. */
export const MODE_NAMES = MODES.map((m) => m.name).join('|');

/**
 * STRUCTURAL allowance, not the preset's taste: since presets write the per-chat
 * switches instead of gating them, these say only whether a feature is possible
 * in the mode at all. Today that means "everything except the tutor" — a study
 * room stays free of jokes/slang/chime/reactions whatever the switches say (and
 * never learns the chat's slang either).
 */
export function modeAllowsHumor(mode: ChatMode): boolean {
  return !modeSpec(mode).toneLocked;
}

export function modeAllowsSlang(mode: ChatMode): boolean {
  return !modeSpec(mode).toneLocked;
}

export function modeAllowsChime(mode: ChatMode): boolean {
  return !modeSpec(mode).toneLocked;
}

export function modeAllowsReactions(mode: ChatMode): boolean {
  return !modeSpec(mode).toneLocked;
}

/**
 * Make the preset's tone stances the chat's actual settings: called when a preset
 * is PICKED (the m:* buttons or /mode), never on read — so afterwards the admin
 * can re-toggle any switch individually and the preset won't fight them.
 */
export function applyModeDefaults(chatId: number, spec: ModeSpec): void {
  setChatHumorEnabled(chatId, spec.defaults.humor);
  setChatSlangEnabled(chatId, spec.defaults.slang);
  setChimeEnabled(chatId, spec.defaults.chime);
  setReactionsEnabled(chatId, spec.defaults.reactions);
}

/** The «что за режимы?» card: every preset with what it's for. */
export function renderModeCard(): string {
  return MODES.map((m) => `${m.label} — ${m.description}`).join('\n\n');
}

const on = (v: boolean) => (v ? 'вкл' : 'выкл');

/**
 * The behaviour setup card (HTML): what each tone feature actually DOES, its
 * current state in this chat, and the tap-to-copy command that toggles it. Shown
 * right after a preset is picked (so the admin sees what the preset just set and
 * how to adjust it) and any time via /setup <chatId>.
 */
export function renderSetupCard(chatId: number): string {
  const spec = modeSpec(getChatMode(chatId));
  const cmd = (c: string) => `<code>${escapeHtml(c)}</code>`;
  const customPrompt = getPersonaPrompt(chatId);
  const lines = [
    `⚙️ Поведение чата <code>${chatId}</code> — пресет ${escapeHtml(spec.label)} задал стартовые настройки, каждую можно крутить отдельно:`,
    '',
    `😜 <b>Юморайзер</b> — ${on(isChatHumorEnabled(chatId))}. Отдельный проход, который переписывает обычные ответы смешнее и живее. Точные ответы (суммы, прогнозы, поиск) не трогает никогда.`,
    `    ${cmd(`/humor ${chatId} on`)} · ${cmd(`/humor ${chatId} off`)}`,
    `🗣 <b>Сленг</b> — ${on(isChatSlangEnabled(chatId))}. Бот тихо выучивает словечки чата и вплетает их в ответы (только словарь — числа, ссылки и факты неприкосновенны). Список выученного: ${cmd(`/slang ${chatId}`)}.`,
    `    ${cmd(`/slang ${chatId} on`)} · ${cmd(`/slang ${chatId} off`)}`,
    `⚡️ <b>Вбросы</b> — ${on(isChimeEnabled(chatId))}. Когда чат надолго замолкает, бот может сам вкинуть шутку по мотивам последних сообщений, чтобы оживить движ.`,
    `    ${cmd(`/chime ${chatId} on`)} · ${cmd(`/chime ${chatId} off`)}`,
    `👍 <b>Реакции</b> — ${on(isReactionsEnabled(chatId))}. Изредка (≈10%) ставит случайный положительный эмодзи на сообщения.`,
    `    ${cmd(`/react ${chatId} on`)} · ${cmd(`/react ${chatId} off`)}`,
    '',
    `🎭 <b>Свой характер</b> — ${customPrompt ? 'задан' : 'не задан'}. Опиши персону своими словами: ${cmd(`/prompt ${chatId} <текст>`)} (переключает чат в пресет «кастом»).`,
    `📏 <b>Правила</b> — постоянные указания словами («отвечай короче», «голосовые расшифровывай»): ${cmd(`/rules ${chatId} add <текст>`)}.`,
    '',
    `Вся сводка по чату: ${cmd(`/chat ${chatId}`)} · сменить пресет: ${cmd(`/mode ${chatId}`)}`,
  ];
  if (spec.toneLocked) {
    lines.splice(
      1,
      0,
      '',
      '🎓 В режиме репетитора шутки, сленг, вбросы и реакции отключены наглухо — точность важнее, переключатели ниже на него не действуют.',
    );
  }
  return lines.join('\n');
}
