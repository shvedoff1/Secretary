import { z } from 'zod';
import type { ParsedExpense } from '../core/types.js';
import { majorToMinor } from '../util/money.js';

// Zod schema used to validate the `record_expense` tool input the model emits.
// Amounts are in the currency's NATURAL (major) units, exactly as said — the code
// converts to minor units (knowing which currencies have no sub-unit), so the
// model never has to guess the decimal scale (and can't ×100 a currency like IDR).
export const ParsedSplitZ = z.object({
  memberHint: z.string(),
  amount: z.number().nonnegative().nullable(),
  share: z.number().nullable(),
});

export const RecordExpenseZ = z.object({
  title: z.string().min(1),
  amount: z.number().nonnegative(),
  currency: z.string().min(3).max(3),
  payerHints: z.array(z.string()),
  profiteerHints: z.array(z.string()),
  splits: z.array(ParsedSplitZ).nullable(),
  confidence: z.number().min(0).max(1),
  notes: z.string().nullable(),
});

export type RecordExpenseInput = z.infer<typeof RecordExpenseZ>;

export function toParsedExpense(input: RecordExpenseInput): ParsedExpense {
  const currency = input.currency.toUpperCase();
  return {
    title: input.title,
    amountMinor: majorToMinor(input.amount, currency),
    currency,
    payerHints: input.payerHints,
    profiteerHints: input.profiteerHints,
    splits:
      input.splits?.map((s) => ({
        memberHint: s.memberHint,
        amountMinor: s.amount == null ? null : majorToMinor(s.amount, currency),
        share: s.share,
      })) ?? null,
    confidence: input.confidence,
    notes: input.notes,
  };
}

export const RememberZ = z.object({
  note: z.string().min(1),
  // Existing remembered facts (verbatim, as shown in context) that this note
  // supersedes/contradicts and should replace. The handler fuzzy-matches and removes
  // them before pinning the new note, so a correction overrides instead of piling up.
  replaces: z.array(z.string().min(1)).optional(),
});
export type RememberInput = z.infer<typeof RememberZ>;

export const EditMemoryZ = z.object({
  find: z.string().min(1),
  replace: z.string().min(1),
});
export type EditMemoryInput = z.infer<typeof EditMemoryZ>;

export const RecallMemoryZ = z.object({
  query: z.string().nullable(),
  about: z.string().nullable(),
});
export type RecallMemoryInput = z.infer<typeof RecallMemoryZ>;

export const LearnExpenseZ = z.object({
  keywords: z.array(z.string().min(1)).min(1).max(20),
});
export type LearnExpenseInput = z.infer<typeof LearnExpenseZ>;

export const EditLexiconZ = z.object({
  term: z.string().min(1),
  gloss: z.string().min(1),
});
export type EditLexiconInput = z.infer<typeof EditLexiconZ>;

export const SetRuleZ = z.object({
  action: z.enum(['add', 'remove']),
  text: z.string().min(1),
});
export type SetRuleInput = z.infer<typeof SetRuleZ>;

export const MuteWindowInputZ = z.object({
  days: z.array(z.number().int().min(1).max(7)).min(1),
  from: z.string().regex(/^\d{1,2}:\d{2}$/),
  to: z.string().regex(/^\d{1,2}:\d{2}$/),
});
export type MuteWindowInput = z.infer<typeof MuteWindowInputZ>;

export const EditPingListZ = z.object({
  action: z.enum(['add', 'remove', 'mute', 'unmute', 'rename']),
  list: z.string().min(1).nullable(),
  members: z.array(z.string().min(1)).min(1).max(20),
  mute: z.array(MuteWindowInputZ).min(1).nullable().optional(),
  timezone: z.string().min(1).nullable().optional(),
  // For action=rename: the corrected handle; members[0] is the old/wrong one.
  renameTo: z.string().min(1).nullable().optional(),
  // For action=mute: true → the windows REPLACE the member's previous schedule
  // (a full restatement: «теперь только…», a correction); false → they are
  // ADDED on top («ещё не тегай в субботу утром»). Absent/null defaults to
  // append — adding preserves data, replacing destroys it.
  replace: z.boolean().nullable().optional(),
});
export type EditPingListInput = z.infer<typeof EditPingListZ>;

export const AddPoiZ = z.object({
  name: z.string().min(1),
  category: z.enum(['cafe', 'sight', 'plan', 'place']),
  description: z.string().nullable(),
  address: z.string().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
});
export type AddPoiInput = z.infer<typeof AddPoiZ>;

export const ScheduleTaskZ = z.object({
  title: z.string().min(1),
  prompt: z.string().min(1),
  cron: z.string().min(1),
  timezone: z.string().min(1),
  once: z.boolean(),
  humor: z.boolean(),
});
export type ScheduleTaskInput = z.infer<typeof ScheduleTaskZ>;

export const WatchPageZ = z.object({
  title: z.string().min(1),
  url: z.string().url(),
  condition: z.string().min(1),
  keywords: z.array(z.string().min(1)).min(1).max(10),
  intervalMinutes: z.number().int().positive().nullable(),
  expiresInDays: z.number().int().positive().nullable(),
});
export type WatchPageInput = z.infer<typeof WatchPageZ>;

export const DotaLookupZ = z.object({
  kind: z.enum(['hero', 'item', 'patch', 'any']),
  names: z.array(z.string().min(1)).max(8).nullable(),
  query: z.string().nullable(),
});
export type DotaLookupInput = z.infer<typeof DotaLookupZ>;

export const SurfForecastZ = z.object({
  spots: z
    .array(
      z.object({
        name: z.string().min(1),
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
      }),
    )
    .min(1)
    .max(8),
  day: z.enum(['today', 'tomorrow']),
  timezone: z.string().min(1),
});
export type SurfForecastInput = z.infer<typeof SurfForecastZ>;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const SpendingReportZ = z.object({
  fromDate: z.string().regex(DATE_RE).nullable(),
  toDate: z.string().regex(DATE_RE).nullable(),
  balances: z.boolean(),
  filterLabel: z.string().nullable(),
  filterKeywords: z.array(z.string()).nullable(),
  timezone: z.string().min(1),
});
export type SpendingReportInput = z.infer<typeof SpendingReportZ>;

// Read back the chat's raw message log (chat_message_log) so the model can recap
// what was said — including everything the bot never replied to.
export const SummarizeChatZ = z.object({
  limit: z.number().int().positive().nullable(),
  fromDate: z.string().regex(DATE_RE).nullable(),
  toDate: z.string().regex(DATE_RE).nullable(),
  timezone: z.string().min(1),
});
export type SummarizeChatInput = z.infer<typeof SummarizeChatZ>;

// --- JSON Schemas for the Anthropic tool definitions (strict tool use) ---

export const recordExpenseJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', description: 'Short human-readable title, e.g. "Taxi", "Dinner".' },
    amount: {
      type: 'number',
      description:
        'Total amount in the currency\'s NATURAL units, exactly as written/spoken — NOT minor units. ' +
        '12.50 EUR => 12.50; 10000 IDR => 10000; 1500 JPY => 1500. Never multiply by 100.',
    },
    currency: {
      type: 'string',
      description: 'ISO 4217 currency code (3 letters). Use the chat default if unstated.',
    },
    payerHints: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Who paid, as written. Empty array => the message sender paid. "me"/"я" allowed.',
    },
    profiteerHints: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Who the expense is split among, as written. Empty array or ["all"]/["все"] => everyone.',
    },
    splits: {
      type: ['array', 'null'],
      description:
        'Uneven split. null => equal split among profiteers. Each entry: amount (absolute, in the same natural units as the top-level amount) OR share (0..1), not both.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          memberHint: { type: 'string' },
          amount: { type: ['number', 'null'] },
          share: { type: ['number', 'null'] },
        },
        required: ['memberHint', 'amount', 'share'],
      },
    },
    confidence: { type: 'number', description: '0..1 confidence in this extraction.' },
    notes: {
      type: ['string', 'null'],
      description: 'Any ambiguity or assumption worth showing the user.',
    },
  },
  required: [
    'title',
    'amount',
    'currency',
    'payerHints',
    'profiteerHints',
    'splits',
    'confidence',
    'notes',
  ],
} as const;

export const rememberJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    note: {
      type: 'string',
      description:
        'A concise fact to remember about this chat/group (trip, preferences, corrections).',
    },
    replaces: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Optional. If this note CORRECTS or CONTRADICTS one or more facts already in the memory sections of the context, put those existing facts here VERBATIM (copy their text as shown). They will be removed so the new note overrides them instead of coexisting. Leave empty/omit when the note is brand-new and conflicts with nothing.',
    },
  },
  required: ['note'],
} as const;

export const editMemoryJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    find: {
      type: 'string',
      description:
        "The existing remembered fact to fix, copied VERBATIM from the memory sections of the context (or enough of it to identify the fact uniquely). e.g. «Итого 5 человек: …».",
    },
    replace: {
      type: 'string',
      description:
        'The corrected full text to store in its place. This overwrites that one fact in place; it does not add a new one.',
    },
  },
  required: ['find', 'replace'],
} as const;

export const recallMemoryJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: {
      type: ['string', 'null'],
      description:
        'What to look for, in the words the fact would most likely be WRITTEN in — the store holds short Russian sentences, so search by their content words («днюха день рождения», «аллергия», «пароль от вайфая»). Give several likely wordings of the same thing rather than one; matching is per-word, so extra synonyms only help. null when you only want everything known about a person (`about`).',
    },
    about: {
      type: ['string', 'null'],
      description:
        'Narrow to facts about ONE person, by the name the chat calls them («Гоша», «Андрей»). Use it alone (with query null) for «что ты помнишь про Гошу», or together with a query to search only that person\'s facts. null to search the whole store.',
    },
  },
  required: ['query', 'about'],
} as const;

export const learnExpenseJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    keywords: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      items: { type: 'string' },
      description:
        'Short, distinctive trigger words or phrases (lower-case, as used in the chat) that should mark a message as a likely expense. Extract them from the example message the user pointed at — e.g. ["дошик", "на бензин", "продукты"]. Keep them generic enough to match future messages but specific enough not to misfire (avoid stop-words like "за"/"на" alone).',
    },
  },
  required: ['keywords'],
} as const;

export const editLexiconJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    term: {
      type: 'string',
      description:
        "The slang word/phrase whose meaning to change, as it appears in this chat's learned slang (lower-case), e.g. «пихалыч», «тип». Take it from the user's message.",
    },
    gloss: {
      type: 'string',
      description:
        'The new short meaning/definition to store for that word, in Russian, e.g. «рот, пасть», «типа». This replaces whatever meaning was learned before.',
    },
  },
  required: ['term', 'gloss'],
} as const;

export const setRuleJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['add', 'remove'],
      description:
        "'add' — the user states a new standing rule; 'remove' — they cancel one that is already listed under \"Chat rules\" in the context block.",
    },
    text: {
      type: 'string',
      description:
        'For add: the rule as ONE short self-contained imperative sentence in the user\'s language, e.g. «Все голосовые расшифровывай, чисти от слов-паразитов и присылай расшифровку» or «Отвечай без эмодзи». Write it so it makes sense with no conversation around it. For remove: the existing rule, copied from the "Chat rules" section of the context block (near-verbatim is enough).',
    },
  },
  required: ['action', 'text'],
} as const;

export const editPingListJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['add', 'remove', 'mute', 'unmute', 'rename'],
      description:
        'add — добавить участников в пинг-список; remove — убрать их из него; mute — установить участникам персональные окна тишины («не тегай меня …»); unmute — снять окна тишины совсем; rename — исправить сохранённый меншн на правильный ник («исправь меншн X на Y») — правки едут во все списки, правила тишины сохраняются.',
    },
    list: {
      type: ['string', 'null'],
      description:
        'Which ping list to edit, when the user names one («в список стак», «из вечернего пинга» => "стак"/"вечерний"). null for the default/main list («основной пинг», «в пинг» with no name). Ignored for mute/unmute — quiet hours are per person for the whole chat.',
    },
    members: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      items: { type: 'string' },
      description:
        'The people to add/remove/mute, copied AS WRITTEN from the message, keeping the @ prefix when present (e.g. ["@vasya", "@petya"]). Several at once is fine. «меня»/«me» => the sender\'s @username from the context block.',
    },
    mute: {
      type: ['array', 'null'],
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          days: {
            type: 'array',
            minItems: 1,
            items: { type: 'integer', minimum: 1, maximum: 7 },
            description:
              'ISO weekdays the window applies to: 1=Mon … 7=Sun. «будни» => [1,2,3,4,5]; «выходные» => [6,7]; «каждый день» => all seven.',
          },
          from: {
            type: 'string',
            description:
              'Window start "HH:MM" (inclusive, 24h clock). «до 19:00» => from "00:00".',
          },
          to: {
            type: 'string',
            description:
              'Window end "HH:MM" (exclusive). «до 19:00» => to "19:00"; «после 22:00» => from "22:00" to "24:00". from > to wraps past midnight.',
          },
        },
        required: ['days', 'from', 'to'],
      },
      description:
        'For action=mute: the DO-NOT-PING windows («не тегай до 19:00 по будням и с 18 до 21 в вс» => [{days:[1,2,3,4,5],from:"00:00",to:"19:00"},{days:[7],from:"18:00",to:"21:00"}]). Whether they replace or extend the existing schedule is decided by `replace`. null for other actions.',
    },
    timezone: {
      type: ['string', 'null'],
      description:
        'IANA timezone the windows are written in. «по московскому»/«по мск» => "Europe/Moscow". null => the default (Europe/Moscow).',
    },
    replace: {
      type: ['boolean', 'null'],
      description:
        'For action=mute — decide from the phrasing. true: the user RESTATES their whole schedule or corrects it («не тегай меня только до 18», «теперь так: …», «вместо этого», their FIRST ever rule) => the windows REPLACE everything stored. false: the user ADDS to an existing schedule («ещё не тегай в субботу утром», «а также…», «плюс в среду») => the windows are appended, old ones stay. When genuinely unsure use false — adding preserves their old rules, replacing destroys them. null for other actions.',
    },
    renameTo: {
      type: ['string', 'null'],
      description:
        'For action=rename: the CORRECT handle to store («исправь меншн @ФилиппФилипп на @philipp» => members ["@ФилиппФилипп"], renameTo "@philipp"). Must be a real @username the user actually wrote — never construct one. null for other actions.',
    },
  },
  required: ['action', 'list', 'members', 'mute', 'timezone', 'replace', 'renameTo'],
} as const;

export const addPoiJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: {
      type: 'string',
      description: 'Short name of the place, e.g. "Кафе Tartine", "Belém Tower".',
    },
    category: {
      type: 'string',
      enum: ['cafe', 'sight', 'plan', 'place'],
      description:
        'cafe = cafe/restaurant/bar/food; sight = landmark/museum/attraction already visited; plan = a place they want to go later; place = anything else.',
    },
    description: {
      type: ['string', 'null'],
      description:
        'Why it is worth keeping, in the user\'s words (e.g. "лучший флэт уайт", "красивый вид на закат"). null if none.',
    },
    address: {
      type: ['string', 'null'],
      description:
        'Street address, neighbourhood, or city if mentioned — used to build a Google Maps search when exact coordinates are unknown. null if none.',
    },
    latitude: {
      type: ['number', 'null'],
      description: 'Latitude if precisely known (e.g. from a shared map pin). null otherwise.',
    },
    longitude: {
      type: ['number', 'null'],
      description: 'Longitude if precisely known. null otherwise.',
    },
  },
  required: ['name', 'category', 'description', 'address', 'latitude', 'longitude'],
} as const;

export const scheduleTaskJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: {
      type: 'string',
      description: 'Short human-readable title, e.g. "Прогноз волн", "Купить молоко".',
    },
    prompt: {
      type: 'string',
      description:
        'Self-contained instruction to run when the task fires (you will receive ONLY this text, no chat history). Include any web-search intent. E.g. "Найди прогноз по волнам для Эрисейры на сегодня и кратко напиши". For a plain reminder phrase it as what to DO when it fires — "Напомни, что пора оплатить подписку" — never the bare task name alone.',
    },
    cron: {
      type: 'string',
      description:
        'Standard 5-field cron expression (minute hour day-of-month month day-of-week) for when to run. "Каждый день в 9:00" => "0 9 * * *". A one-off "через 2 минуты" => the single minute it should fire.',
    },
    timezone: {
      type: 'string',
      description:
        'IANA timezone for the cron schedule (e.g. "Europe/Lisbon"). Use the chat timezone from the context block; if unknown, ask the user once before calling this tool.',
    },
    once: {
      type: 'boolean',
      description: 'true for a one-off reminder (disable after it fires); false for a recurring task.',
    },
    humor: {
      type: 'boolean',
      description:
        "Whether to run this task's reply through the funny tone-only humorizer when it fires. " +
        'Set true when the user wants a light/joking tone ("шути", "с приколами", "рофельный прогноз", "make it funny"); ' +
        'false for a plain, serious reminder/task ("напомни без приколов", a sober reminder). When unsure, default to false. ' +
        'Only affects plain-chat replies — factual tool answers always stay verbatim.',
    },
  },
  required: ['title', 'prompt', 'cron', 'timezone', 'once', 'humor'],
} as const;

export const watchPageJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: {
      type: 'string',
      description:
        'Short human-readable title of what is being awaited, e.g. "Сеансы «Титана» в Киномаксе".',
    },
    url: {
      type: 'string',
      description:
        'The exact http(s) page to poll, as the user gave it (e.g. "https://kinomax.ru/titan/2026-08-06").',
    },
    condition: {
      type: 'string',
      description:
        'The awaited EVENT, precisely, in Russian — including what counts as real evidence, so a checking model can judge strictly. E.g. «в расписании появились сеансы (конкретные времена) фильма „Титан“ — не анонс, не „скоро в кино“, не сеансы других фильмов».',
    },
    keywords: {
      type: 'array',
      minItems: 1,
      maxItems: 10,
      items: { type: 'string' },
      description:
        'Lowercase substrings that will appear on the page when the event is possible — they GATE the check (no keyword on the page => no check), so make them identify the TARGET: the film/product title in the page\'s language plus useful variants/translit (e.g. ["титан", "titan"]). Avoid generic words like «сеанс» alone — they match any page state.',
    },
    intervalMinutes: {
      type: ['number', 'null'],
      description:
        'How often to poll, in minutes, when the user asks for a pace («проверяй каждые 5 минут» => 5). null => the default (~15 min).',
    },
    expiresInDays: {
      type: ['number', 'null'],
      description:
        'Stop watching after this many days if the event never happens, when the user bounds it («следи неделю» => 7). null => the default (~2 weeks).',
    },
  },
  required: ['title', 'url', 'condition', 'keywords', 'intervalMinutes', 'expiresInDays'],
} as const;

export const dotaLookupJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: {
      type: 'string',
      enum: ['hero', 'item', 'patch', 'any'],
      description:
        "What is being looked up: 'hero' (герой, его способности/статы/таланты), 'item' (предмет), 'patch' (что изменилось в последнем патче у конкретного героя/предмета), 'any' when unsure.",
    },
    names: {
      type: ['array', 'null'],
      maxItems: 8,
      items: { type: 'string' },
      description:
        'Canonical ENGLISH names of the heroes/items asked about, as Valve spells them — "Anti-Mage", "Blink Dagger", "Black King Bar". Translate the chat\'s Russian/slang naming yourself («ам», «анти-маг» => "Anti-Mage"; «бкб» => "Black King Bar"; «спешка» => "Hand of Midas" only if that is really what they mean). Never pass a Russian name — the base stores English ones. null when you only have a freetext query.',
    },
    query: {
      type: ['string', 'null'],
      description:
        'Freetext search over the base for questions that name no specific entity — "предметы с спелл-вампиризмом", "кто даёт сайленс". Words are matched against names and descriptions. null when `names` already covers the question.',
    },
  },
  required: ['kind', 'names', 'query'],
} as const;

export const surfForecastJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    spots: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      description:
        'Several popular surf spots near the region the user means. YOU choose them from your own knowledge of the area (the user gives a region/point, not a spot list). Pick 3-6 well-known spots.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', description: 'Spot name, e.g. "Ribeira d\'Ilhas".' },
          latitude: {
            type: 'number',
            description: 'Latitude of a point IN THE WATER at the spot (decimal degrees).',
          },
          longitude: {
            type: 'number',
            description: 'Longitude of a point IN THE WATER at the spot (decimal degrees).',
          },
        },
        required: ['name', 'latitude', 'longitude'],
      },
    },
    day: {
      type: 'string',
      enum: ['today', 'tomorrow'],
      description: 'Which day to forecast.',
    },
    timezone: {
      type: 'string',
      description:
        'IANA timezone for "today"/"tomorrow" and daytime hours. Use the chat timezone from the context block.',
    },
  },
  required: ['spots', 'day', 'timezone'],
} as const;

export const spendingReportJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    fromDate: {
      type: ['string', 'null'],
      description:
        'Start of the period as a chat-LOCAL date YYYY-MM-DD (inclusive). Compute concrete dates from "Current time (UTC)" + "Chat timezone" in the context block. "за вчера" => yesterday for both from and to; "сегодня" => today for both; "за последние 3 дня" => from = 3 days ago, to = today. null for both from/to means yesterday (a daily summary).',
    },
    toDate: {
      type: ['string', 'null'],
      description: 'End of the period as a chat-LOCAL date YYYY-MM-DD (inclusive). For a single day, equal to fromDate.',
    },
    balances: {
      type: 'boolean',
      description:
        'true to include a who-owes-whom settlement summary ("сколько кто кому должен", "who owes what"). Set true (and you may leave fromDate/toDate null) when the user asks ONLY about balances/debts; set true alongside dates to show both spending and balances.',
    },
    filterLabel: {
      type: ['string', 'null'],
      description:
        'Short human label of the category filter for the header, in the user\'s words (e.g. "еду", "такси", "transport"). null when the user wants ALL spending (no category filter).',
    },
    filterKeywords: {
      type: ['array', 'null'],
      items: { type: 'string' },
      description:
        'Lowercase match terms for an APPROXIMATE category filter (substring-matched against each expense\'s title + category). Expand the user\'s category GENEROUSLY in BOTH languages AND include the relevant Splid category type(s): accommodation, entertainment, groceries, restaurants, transport. E.g. "на еду" => ["еда","ресторан","кафе","продукты","food","restaurant","groceries"]; "на такси/транспорт" => ["такси","транспорт","бензин","taxi","transport","uber"]. null/[] = no filter (all spending).',
    },
    timezone: {
      type: 'string',
      description: 'IANA timezone for resolving the local dates. Use the chat timezone from the context block.',
    },
  },
  required: ['fromDate', 'toDate', 'balances', 'filterLabel', 'filterKeywords', 'timezone'],
} as const;

export const summarizeChatJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: {
      type: ['integer', 'null'],
      description:
        'How many of the most recent messages to read, when the user names a count ("что было в последних 200 сообщениях" => 200). null => the bot default (a couple of hundred). Values above the configured ceiling are clamped.',
    },
    fromDate: {
      type: ['string', 'null'],
      description:
        'Start of the period as a chat-LOCAL date YYYY-MM-DD (inclusive), when the user asks by TIME rather than by count ("о чём болтали вчера", "перескажи, что было за выходные"). Compute concrete dates from "Current time (UTC)" + "Chat timezone" in the context block. null when the user asked by count or said nothing about a period.',
    },
    toDate: {
      type: ['string', 'null'],
      description: 'End of the period as a chat-LOCAL date YYYY-MM-DD (inclusive). Equal to fromDate for a single day; null when fromDate is null.',
    },
    timezone: {
      type: 'string',
      description: 'IANA timezone for resolving the local dates and rendering times. Use the chat timezone from the context block.',
    },
  },
  required: ['limit', 'fromDate', 'toDate', 'timezone'],
} as const;
