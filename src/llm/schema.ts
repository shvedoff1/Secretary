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
