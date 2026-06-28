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

  ANTHROPIC_MODEL: z.string().default('claude-sonnet-4-6'),
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
  // Weighted memory: passively extract durable, salient facts from the chat (split
  // into shared chat facts and per-person facts), decay them over time, reinforce
  // re-mentioned ones, and inject a tight working set into the assistant context —
  // so recall behaves like a person's. Mirrors the lexicon batching economics.
  ENABLE_MEMORY: boolish.default(true),
  // Cheap model used only for the memory extraction batches (not the main chat).
  ANTHROPIC_MEMORY_MODEL: z.string().default('claude-haiku-4-5-20251001'),
  // Fire an extraction batch once this many messages have buffered...
  MEMORY_BATCH_SIZE: z.coerce.number().int().positive().default(40),
  // ...or once the oldest buffered message is this old, whichever comes first.
  MEMORY_MAX_AGE_HOURS: z.coerce.number().int().positive().default(24),
  // Days for a passive fact's weight to halve (older events carry less weight).
  MEMORY_HALFLIFE_DAYS: z.coerce.number().int().positive().default(14),
  // Hard cap on stored passive facts per chat; lowest-weight overflow is pruned
  // (pinned facts are exempt). This is the "limited volume" of human-like memory.
  MEMORY_MAX_ITEMS: z.coerce.number().int().positive().default(200),
  // How many shared chat facts to inject into the assistant context.
  MEMORY_CONTEXT_CHAT: z.coerce.number().int().positive().default(8),
  // How many facts about the current sender to inject into the assistant context.
  MEMORY_CONTEXT_USER: z.coerce.number().int().positive().default(6),
  // Fallback IANA timezone for reminders when a chat hasn't set one yet.
  DEFAULT_TIMEZONE: z.string().min(1).default('UTC'),
  // Spontaneous "chime-in": occasionally jump into group chatter the bot wasn't
  // addressed in, continuing the conversation by context as if it had been pinged.
  // To avoid butting into an active back-and-forth (and lagging behind), it doesn't
  // reply immediately — it waits for a lull (CHIME_QUIET_SECONDS of silence after
  // the message it rolled on) and only then calls the LLM. Any new message in that
  // window cancels the pending chime, so it lands only when the chat has gone quiet.
  ENABLE_CHIME: boolish.default(true),
  // Probability (0..1) that an otherwise-ignored group message arms a chime.
  CHIME_PROBABILITY: z.coerce.number().min(0).max(1).default(0.1),
  // Seconds of silence to wait after arming before the bot actually replies.
  CHIME_QUIET_SECONDS: z.coerce.number().int().positive().default(60),
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
