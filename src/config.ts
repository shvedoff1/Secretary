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

  ANTHROPIC_MODEL: z.string().default('claude-sonnet-5'),
  // Speech-to-text for voice messages. Optional: without a key, voice notes are
  // ignored (we never transcribe). OpenAI's audio API is called over plain HTTP,
  // so no extra npm dependency is needed.
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_TRANSCRIBE_MODEL: z.string().default('whisper-1'),
  // Priming text sent to the transcription API as `prompt`. Whisper uses it to
  // bias spelling/vocabulary — nudging it toward this bot's domain (expenses,
  // amounts, currencies, Russian names) so a spoken «запиши трату 10 тысяч …»
  // comes back cleaner instead of garbled. Set empty to disable.
  OPENAI_TRANSCRIBE_PROMPT: z
    .string()
    .default(
      'Голосовое сообщение боту-секретарю про траты и расходы: суммы, рубли, доллары, рупии, имена людей, кто за кого платил и на кого делить.',
    ),
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  // Optional "humorizer" pass: after Anthropic produces an accurate answer, a
  // cheap OpenAI model rewrites the TONE of plain-chat replies to be funnier.
  // Off by default and needs OPENAI_API_KEY; it never runs on factual/tool
  // answers (expenses, surf, web search, reminders) so accuracy is preserved.
  ENABLE_HUMOR: boolish.default(false),
  OPENAI_HUMOR_MODEL: z.string().default('gpt-5.5'),
  // GPT-5-family models are REASONING models: left to their defaults they burn
  // time on hidden reasoning tokens before answering, which makes the humorizer /
  // expense-quip pass feel far slower than Claude even though the task is a trivial
  // tone rewrite. This knob dials that down. 'low' (the default) keeps the pass
  // quick while still giving the model enough headroom to do a real rewrite — pure
  // 'minimal' turned out to make the tone rewrite lazy (near-verbatim echoes). Use
  // 'none' to omit the field entirely for non-reasoning models (e.g. gpt-4o-mini)
  // that reject it.
  OPENAI_REASONING_EFFORT: z
    .enum(['none', 'minimal', 'low', 'medium', 'high'])
    .default('low'),
  // Hard cap (ms) on a single humorizer / expense-quip OpenAI call so a slow tone
  // pass can never hold a reply hostage. On timeout the humorizer falls back to the
  // original text and the quip is skipped — both are best-effort by design.
  OPENAI_HUMOR_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
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
  // Slang pass: apply the chat's learned lexicon to replies the HUMORIZER never
  // touches (tool/factual answers, money answers, chats with humour switched
  // off). It's a vocabulary-only rewrite — no jokes — guarded by a
  // fact-preservation check, so exact answers keep their numbers/links. Needs
  // OPENAI_API_KEY; reuses OPENAI_HUMOR_MODEL and its reasoning/timeout knobs.
  // On by default, per-chat switch via `/slang [<chatId>] on|off`.
  ENABLE_SLANG: boolish.default(true),
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
  // (pinned facts are exempt). Storage is cheap and costs NO tokens — what a turn
  // pays for is the injected working set below, which is bounded separately — so the
  // cap is generous and exists only to stop unbounded growth. Anything beyond the
  // working set stays reachable through the `recall_memory` tool.
  MEMORY_MAX_ITEMS: z.coerce.number().int().positive().default(2000),
  // How many memory items /memory and /chat print. The store is deep now, so a full
  // dump would be dozens of Telegram messages (and a single reply would exceed the
  // 4096-char cap outright); /forget <N> still addresses the full list by index.
  MEMORY_DISPLAY_LIMIT: z.coerce.number().int().positive().default(60),
  // How many facts one `recall_memory` search returns. This IS a token cost (it lands
  // in the tool result), so it is a working-set-sized number, not a page of the store.
  MEMORY_RECALL_LIMIT: z.coerce.number().int().positive().default(10),
  // How many rotating PASSIVE shared chat facts to inject into the assistant context.
  MEMORY_CONTEXT_CHAT: z.coerce.number().int().positive().default(8),
  // How many EXPLICIT (pinned / remembered) chat facts to always inject on top, so a
  // deliberately remembered fact is guaranteed into context and never squeezed out.
  MEMORY_CONTEXT_PINNED: z.coerce.number().int().positive().default(24),
  // How many facts about the current sender to inject into the assistant context.
  MEMORY_CONTEXT_USER: z.coerce.number().int().positive().default(6),
  // How many facts about EACH other recently-active participant to inject. Higher
  // gives richer per-person blocks (the point of keeping per-person memory at all).
  MEMORY_CONTEXT_OTHER: z.coerce.number().int().positive().default(2),
  // Max number of other participants to include per turn.
  MEMORY_CONTEXT_MAX_OTHERS: z.coerce.number().int().positive().default(4),
  // Max voice/style ("persona") directives to inject. These live in their own context
  // section so they don't compete with factual chat memory for the chat budget.
  MEMORY_CONTEXT_PERSONA: z.coerce.number().int().positive().default(20),
  // Page watches ("вотчеры"): poll a URL until an awaited event appears on it
  // («следи за страницей и напиши, когда появятся сеансы»), then notify the chat.
  ENABLE_WATCH: boolish.default(true),
  // Cheap model that judges "did the event happen?" from a page excerpt each poll
  // (the keyword gate + unchanged-page hash keep most polls from reaching it).
  ANTHROPIC_WATCH_MODEL: z.string().default('claude-haiku-4-5-20251001'),
  // Default poll interval when the user doesn't ask for a pace.
  WATCH_INTERVAL_MINUTES: z.coerce.number().int().positive().default(15),
  // Default lifetime: a watch that never fires disarms (with a note) after this.
  WATCH_EXPIRES_DAYS: z.coerce.number().int().positive().default(14),
  // Cap on active watches per chat so one chat can't fill the poll loop.
  WATCH_MAX_PER_CHAT: z.coerce.number().int().positive().default(10),
  // Hard cap (ms) on a single page fetch.
  WATCH_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  // Dota knowledge base: a nightly crawl of Valve's datafeed (heroes, items,
  // abilities, talents, patch notes) into SQLite, read by the `dota_lookup` tool
  // in dota-mode chats so answers carry CURRENT-patch numbers instead of the
  // model's stale training data. Needs no API key.
  ENABLE_DOTA: boolish.default(true),
  // Feed language for descriptions. Names are never localised by Valve, so this
  // only affects prose ('russian' matches the chat; 'english' is the fallback).
  DOTA_LANGUAGE: z.string().min(1).default('russian'),
  // Hour (UTC) the nightly rebuild runs. A full crawl is ~550 requests, so it is
  // deliberately parked at night; an empty base syncs immediately on startup.
  DOTA_SYNC_HOUR_UTC: z.coerce.number().int().min(0).max(23).default(3),
  // Don't probe the feed more than once per this window (the tick is hourly).
  DOTA_SYNC_MIN_INTERVAL_HOURS: z.coerce.number().int().positive().default(20),
  // Staleness net: rebuild even on an unchanged patch string once data is this
  // old (covers a hotfix shipped without a version bump, or a missed night).
  DOTA_SYNC_MAX_AGE_HOURS: z.coerce.number().int().positive().default(72),
  // How long an EMPTY base waits before retrying a failed build. Without it a
  // feed outage would mean a fresh ~550-request crawl on every hourly tick.
  DOTA_SYNC_RETRY_HOURS: z.coerce.number().int().positive().default(6),
  // Minimum gap between two feed requests — politeness on an undocumented,
  // keyless endpoint. 250ms puts a full crawl at ~5 minutes.
  DOTA_FEED_DELAY_MS: z.coerce.number().int().nonnegative().default(250),
  DOTA_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  // Cap on how many entities one dota_lookup call returns (token guard).
  DOTA_MAX_CARDS: z.coerce.number().int().positive().default(4),
  // Fallback IANA timezone for reminders when a chat hasn't set one yet.
  DEFAULT_TIMEZONE: z.string().min(1).default('UTC'),
  // Spontaneous "chime-in": occasionally jump into group chatter the bot wasn't
  // addressed in, continuing the conversation by context as if it had been pinged.
  // To avoid butting into an active back-and-forth (and lagging behind), it does NOT
  // roll on the message itself — it waits for a lull (CHIME_QUIET_SECONDS of silence
  // after the last message) and ONLY THEN rolls CHIME_PROBABILITY; a win calls the
  // LLM. Any new message resets the silence clock, so the roll only happens once the
  // chat has gone quiet.
  ENABLE_CHIME: boolish.default(true),
  // Probability (0..1) the bot chimes in, rolled once the chat has gone quiet.
  CHIME_PROBABILITY: z.coerce.number().min(0).max(1).default(0.1),
  // Seconds of silence to wait before rolling for (and possibly sending) a chime.
  CHIME_QUIET_SECONDS: z.coerce.number().int().positive().default(60),
  // Second, escalated tier: if the chat stays dead this much longer (default an
  // hour of silence) AND the first roll already lost, roll again with the higher
  // CHIME_HOUR_PROBABILITY — a long-dead chat gets a much better chance of a revive.
  CHIME_HOUR_SECONDS: z.coerce.number().int().positive().default(3600),
  CHIME_HOUR_PROBABILITY: z.coerce.number().min(0).max(1).default(0.6),
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
