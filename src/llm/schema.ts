import { z } from 'zod';
import type { ParsedExpense } from '../core/types.js';

// Zod schema used to validate the `record_expense` tool input the model emits.
export const ParsedSplitZ = z.object({
  memberHint: z.string(),
  amountMinor: z.number().int().nullable(),
  share: z.number().nullable(),
});

export const RecordExpenseZ = z.object({
  title: z.string().min(1),
  amountMinor: z.number().int().nonnegative(),
  currency: z.string().min(3).max(3),
  payerHints: z.array(z.string()),
  profiteerHints: z.array(z.string()),
  splits: z.array(ParsedSplitZ).nullable(),
  confidence: z.number().min(0).max(1),
  notes: z.string().nullable(),
});

export type RecordExpenseInput = z.infer<typeof RecordExpenseZ>;

export function toParsedExpense(input: RecordExpenseInput): ParsedExpense {
  return {
    title: input.title,
    amountMinor: input.amountMinor,
    currency: input.currency.toUpperCase(),
    payerHints: input.payerHints,
    profiteerHints: input.profiteerHints,
    splits: input.splits,
    confidence: input.confidence,
    notes: input.notes,
  };
}

export const RememberZ = z.object({
  note: z.string().min(1),
});
export type RememberInput = z.infer<typeof RememberZ>;

export const ScheduleTaskZ = z.object({
  title: z.string().min(1),
  prompt: z.string().min(1),
  cron: z.string().min(1),
  timezone: z.string().min(1),
  once: z.boolean(),
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

// --- JSON Schemas for the Anthropic tool definitions (strict tool use) ---

export const recordExpenseJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', description: 'Short human-readable title, e.g. "Taxi", "Dinner".' },
    amountMinor: {
      type: 'integer',
      description:
        'Total amount in MINOR units (e.g. cents). 12.50 EUR => 1250. Whole-unit currencies (JPY) use the bare number.',
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
        'Uneven split. null => equal split among profiteers. Each entry: amountMinor (absolute) OR share (0..1), not both.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          memberHint: { type: 'string' },
          amountMinor: { type: ['integer', 'null'] },
          share: { type: ['number', 'null'] },
        },
        required: ['memberHint', 'amountMinor', 'share'],
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
    'amountMinor',
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
  },
  required: ['title', 'prompt', 'cron', 'timezone', 'once'],
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
