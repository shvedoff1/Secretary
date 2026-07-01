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
});
export type RememberInput = z.infer<typeof RememberZ>;

export const LearnExpenseZ = z.object({
  keywords: z.array(z.string().min(1)).min(1).max(20),
});
export type LearnExpenseInput = z.infer<typeof LearnExpenseZ>;

export const EditLexiconZ = z.object({
  term: z.string().min(1),
  gloss: z.string().min(1),
});
export type EditLexiconInput = z.infer<typeof EditLexiconZ>;

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
  },
  required: ['note'],
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
        'Self-contained instruction to run when the task fires (you will receive ONLY this text, no chat history). Include any web-search intent. E.g. "Найди прогноз по волнам для Эрисейры на сегодня и кратко напиши".',
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
