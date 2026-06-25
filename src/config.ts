import 'dotenv/config';
import { z } from 'zod';

const boolish = z
  .string()
  .transform((v) => v.trim().toLowerCase())
  .pipe(z.enum(['true', 'false', '1', '0', 'yes', 'no']))
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const ConfigSchema = z.object({
  BOT_TOKEN: z.string().min(1, 'BOT_TOKEN is required'),
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
  ADMIN_TELEGRAM_ID: z.coerce.number().int().positive(),

  ANTHROPIC_MODEL: z.string().default('claude-opus-4-8'),
  // Speech-to-text for voice messages. Optional: without a key, voice notes are
  // ignored (we never transcribe). OpenAI's audio API is called over plain HTTP,
  // so no extra npm dependency is needed.
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_TRANSCRIBE_MODEL: z.string().default('whisper-1'),
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  // Optional "humorizer" pass: after Anthropic produces an accurate answer, a
  // cheap OpenAI model rewrites the TONE of plain-chat replies to be funnier.
  // Off by default and needs OPENAI_API_KEY; it never runs on factual/tool
  // answers (expenses, surf, web search, reminders) so accuracy is preserved.
  ENABLE_HUMOR: boolish.default(false),
  OPENAI_HUMOR_MODEL: z.string().default('gpt-5-mini'),
  // Optional "expense quip": when an expense is detected, a cheap OpenAI model
  // riffs a 1-2 line joke that is sent as a SEPARATE message next to the expense
  // preview. It carries no expense data (the preview/confirm flow is untouched),
  // so it can never corrupt amounts/names. Needs OPENAI_API_KEY; reuses
  // OPENAI_HUMOR_MODEL. On by default — best-effort, never blocks the expense.
  ENABLE_EXPENSE_QUIP: boolish.default(true),
  DEFAULT_CURRENCY: z
    .string()
    .length(3)
    .transform((v) => v.toUpperCase())
    .default('EUR'),
  DATABASE_PATH: z.string().default('./data/bot.sqlite'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
  PENDING_TTL_MINUTES: z.coerce.number().int().positive().default(30),
  CONVERSATION_HISTORY_LIMIT: z.coerce.number().int().positive().default(20),
  // Drop dialogue history older than this many hours from the assistant context.
  // Without an age bound the window is count-only, so a long off-topic session
  // lingers (and the bot keeps re-reading its own replies) until enough NEW
  // exchanges push it out — in a quiet chat that can be days. The age cutoff lets
  // yesterday's tangent expire on its own.
  CONVERSATION_HISTORY_MAX_AGE_HOURS: z.coerce.number().int().positive().default(12),
  ENABLE_WEB_SEARCH: boolish.default(true),
  // surf_forecast tool (Open-Meteo marine API; no key needed).
  ENABLE_SURF: boolish.default(true),
  // Lexicon learning: passively buffer chat messages and, in batches, extract the
  // slang / distorted word-forms the group uses so the assistant talks like them.
  ENABLE_LEXICON: boolish.default(true),
  // Cheap model used only for the lexicon extraction batches (not the main chat).
  ANTHROPIC_LEXICON_MODEL: z.string().default('claude-haiku-4-5-20251001'),
  // Fire an extraction batch once this many messages have buffered...
  LEXICON_BATCH_SIZE: z.coerce.number().int().positive().default(30),
  // ...or once the oldest buffered message is this old, whichever comes first.
  LEXICON_MAX_AGE_HOURS: z.coerce.number().int().positive().default(24),
  // How many learned terms to feed back into the assistant context.
  LEXICON_MAX_TERMS: z.coerce.number().int().positive().default(40),
  // Fallback IANA timezone for reminders when a chat hasn't set one yet.
  DEFAULT_TIMEZONE: z.string().min(1).default('UTC'),
});

export type Config = z.infer<typeof ConfigSchema>;

let cached: Config | undefined;

export function loadConfig(): Config {
  if (cached) return cached;
  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}
