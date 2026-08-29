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
  // Raw chat log: record EVERY message the bot sees (plus its own posts) so it can
  // summarise what was said — including the chatter it never replied to. The
  // assistant's own history window (CONVERSATION_HISTORY_LIMIT) is far too small and
  // too selective for that: it holds only turns the bot took part in. Read back by
  // the `summarize_chat` tool; storage costs no tokens, only the summary does.
  ENABLE_CHAT_LOG: boolish.default(true),
  // Hard bounds on the log, applied per chat: keep at most this many lines...
  CHAT_LOG_KEEP_PER_CHAT: z.coerce.number().int().positive().default(4000),
  // ...and drop anything older than this, whichever bites first.
  CHAT_LOG_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  // How many messages a summary reads when the user doesn't name a number.
  SUMMARY_DEFAULT_MESSAGES: z.coerce.number().int().positive().default(200),
  // Ceiling on one summarize_chat call. Generous because a big window no longer
  // goes to the main model verbatim — see the condense pass below.
  SUMMARY_MAX_MESSAGES: z.coerce.number().int().positive().default(1000),
  // How much VERBATIM transcript the main model may receive. A window that fits is
  // passed through untouched; anything bigger goes through the condense pass (or, if
  // that is off, is cut from the OLDEST end with the cut reported).
  SUMMARY_CHAR_BUDGET: z.coerce.number().int().positive().default(14_000),
  // Two-tier recap: when the window doesn't fit verbatim, a cheap model compresses
  // the OLDER part into dense notes and only the newest slice stays word-for-word.
  // That's what lets «перескажи последние 500 сообщений» actually cover 500 messages
  // instead of the last couple of hundred. Off => plain oldest-first truncation.
  ENABLE_SUMMARY_CONDENSE: boolish.default(true),
  // Cheap model used only for that compression pass (never for the recap itself).
  ANTHROPIC_SUMMARY_MODEL: z.string().default('claude-haiku-4-5-20251001'),
  // Newest slice kept verbatim, so the recap (and follow-ups about it) still has the
  // exact recent wording rather than notes about it.
  SUMMARY_TAIL_CHAR_BUDGET: z.coerce.number().int().positive().default(6_000),
  // How much transcript goes into ONE compression call, and how many such calls one
  // recap may fan out to (they run in parallel). chunk × max = the hard ceiling on
  // how far back a single recap can reach; overflow is dropped oldest-first and
  // reported.
  SUMMARY_CONDENSE_CHUNK_CHARS: z.coerce.number().int().positive().default(20_000),
  SUMMARY_CONDENSE_MAX_CHUNKS: z.coerce.number().int().positive().default(8),
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
  // Passive learning (lexicon + memory) from FORWARDED messages. Off by default:
  // a forward is someone else's words about someone else's life, so learning from
  // it teaches the bot a stranger's voice and fills the chat's memory with facts
  // nobody here stated. Set true to restore the old (learn-from-everything)
  // behaviour. The model still SEES forwarded messages — they are just marked as
  // forwarded, so chat rules can decide what to do with them.
  LEARN_FROM_FORWARDS: boolish.default(false),
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
  // Forward batch: forwarded messages are not answered one by one — they are
  // collected per chat (text, voice transcripts, photo captions), each marked
  // with a 🫡 reaction, and processed together when the user asks (or taps the
  // reaction). Off restores the old per-message behaviour.
  ENABLE_FORWARD_BUFFER: boolish.default(true),
  // How long an unclaimed batch waits before quietly expiring (sliding from the
  // last forwarded message).
  FORWARD_BUFFER_TTL_MINUTES: z.coerce.number().int().positive().default(10),
  // Max messages kept per batch — the batch lands in one LLM turn, so this caps
  // the context it can consume. Extra forwards are counted but not stored.
  FORWARD_BUFFER_MAX: z.coerce.number().int().positive().default(50),
  // Max PICTURES attached to the turn that consumes a batch (each costs ~1–1.5k
  // tokens). The first N forwarded photos go in as real images; the rest stay
  // caption-only and the batch says so. 0 = captions only, as before.
  FORWARD_BUFFER_MAX_PHOTOS: z.coerce.number().int().nonnegative().default(8),
  // INLINE mode (@bot вопрос in any chat): the user picks the «спросить» card, a
  // placeholder message is posted, and the bot edits the answer in via
  // chosen_inline_result. Needs BotFather setup (/setinline + /setinlinefeedback
  // at 100%) — without feedback the placeholder is never filled in. Whitelisted
  // (approved) users only; randoms get a "закрыто" stub, never an LLM call.
  ENABLE_INLINE: boolish.default(true),
  // Attached FILES (documents): images sent uncompressed, PDFs, plain-text files.
  // Off = the bot ignores documents exactly as it did before they were handled.
  ENABLE_FILE_INPUT: boolish.default(true),
  // Hard size cap on an attached file. Telegram's Bot API caps downloads at 20 MB
  // anyway; the tighter default keeps one PDF from eating a whole turn's budget.
  FILE_MAX_MB: z.coerce.number().positive().default(10),
  // How much of a TEXT file reaches the model (the rest is cut, and the cut is
  // stated in the turn so the model never pretends it read the whole thing).
  FILE_TEXT_MAX_CHARS: z.coerce.number().int().positive().default(20000),
  // A file that arrived with no explanation is parked (NOT read — that costs
  // tokens) while the bot asks what to do with it. This is how long the next
  // message can still claim it.
  PENDING_FILE_TTL_MINUTES: z.coerce.number().int().positive().default(5),
  // Chat rules: standing behaviour instructions set in plain words («все голосовые
  // очищай от слов-паразитов», «отвечай короче»). Every rule is injected into
  // EVERY turn's context block, so the list must stay short — this cap is what
  // keeps a chat from turning its whole style guide into per-turn tokens.
  CHAT_RULES_MAX: z.coerce.number().int().positive().default(30),
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
  // Episodic memory ("журнал бесед"): when a chat goes quiet, the just-finished
  // conversation session is closed as an EPISODE — a cheap model compresses its
  // chat-log slice into a few lines of notes plus topic tags. The latest episodes
  // are injected into the context as a "conversation journal" (so the model knows
  // what was talked about before its tiny verbatim history window), older ones are
  // searched by recall_memory, and summarize_chat can replay any of them verbatim.
  // Needs the chat log (ENABLE_CHAT_LOG) — episodes are cut from it.
  ENABLE_EPISODES: boolish.default(true),
  // Cheap model that writes the episode notes (never the main chat model).
  ANTHROPIC_EPISODE_MODEL: z.string().default('claude-haiku-4-5-20251001'),
  // Silence that ends a conversation session. Boundaries are detected from the
  // log's own timestamps on the minute tick (durable across restarts), not from
  // in-memory timers.
  EPISODE_QUIET_MINUTES: z.coerce.number().int().positive().default(45),
  // A closed stretch with fewer messages than this is not worth an episode of its
  // own — it is folded into the NEXT session's episode instead of summarised.
  EPISODE_MIN_MESSAGES: z.coerce.number().int().positive().default(4),
  // How many unclosed log messages one close pass reads (newest first). A first
  // run over a deep existing log works backlog off across ticks under this cap.
  EPISODE_MAX_MESSAGES: z.coerce.number().int().positive().default(500),
  // Char budget for the transcript handed to the episode summariser; a longer
  // session is cut from the OLDEST end and the cut is stated to the model.
  EPISODE_CHAR_BUDGET: z.coerce.number().int().positive().default(16_000),
  // Cap on episodes closed per chat per tick (each close is one cheap LLM call).
  EPISODE_MAX_PER_TICK: z.coerce.number().int().positive().default(4),
  // How long a chat waits before retrying after a failed episode-summary call.
  EPISODE_RETRY_MINUTES: z.coerce.number().int().positive().default(30),
  // How many of the newest episodes are injected into the assistant context.
  EPISODE_CONTEXT_COUNT: z.coerce.number().int().positive().default(5),
  // Stored episodes per chat; oldest overflow is pruned.
  EPISODE_KEEP_PER_CHAT: z.coerce.number().int().positive().default(80),
  // How many episode notes one recall_memory search may return (token cost).
  EPISODE_RECALL_LIMIT: z.coerce.number().int().positive().default(3),
  // Cap on the topic-index line in the memory depth hint (paid on every turn).
  MEMORY_TOPIC_INDEX_MAX: z.coerce.number().int().positive().default(12),
  // Hard expiry for passive STATUS facts («сейчас во Вьетнаме», «болеет») — they
  // already decay out of the working set on a much shorter half-life (see
  // memoryWeight.ts), and after this many days since last mention they leave the
  // STORE entirely, deterministically. A stale "current state" served as current
  // is worse than a forgotten one. Traits and pinned facts are never expired.
  MEMORY_STATUS_TTL_DAYS: z.coerce.number().int().positive().default(60),
  // Profile cards: at episode close, a cheap model rewrites a 2-5 line portrait
  // of the chat and of each person heard from (chat_profile), from the previous
  // card + the new episode notes + the current top facts. Facts are ground truth
  // — the card is a derived view and a correction to memory overrides it on the
  // next refresh. Rendered as the "Profile memory" section of the context block.
  ENABLE_PROFILES: boolish.default(true),
  // Cheap model that rewrites the cards (never the main chat model).
  ANTHROPIC_PROFILE_MODEL: z.string().default('claude-haiku-4-5-20251001'),
  // How many cards the context block shows (chat card first, then most recently
  // refreshed people). Cards are a per-turn token cost, so this stays small.
  PROFILE_CONTEXT_MAX: z.coerce.number().int().positive().default(6),
  // Hard cap on one card's length, enforced at parse time — a card is a portrait,
  // not an essay, and an unbounded card would quietly eat the context budget.
  PROFILE_CARD_MAX_CHARS: z.coerce.number().int().positive().default(500),
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
  // Flight status ("чекни рейс") + flight watches ("следи за рейсом и напиши,
  // если отменят/перенесут"): live flight data from aviationstack.com. Both
  // tools appear only when an API key is set — without one the model simply
  // never sees them (web_search still answers flight questions as before).
  ENABLE_FLIGHTS: boolish.default(true),
  // FlightAware AeroAPI key (https://www.flightaware.com/commercial/aeroapi/):
  // the PREFERRED provider — pay-per-query with no monthly minimum and a $5/mo
  // free usage allowance on the Personal tier, which comfortably covers a few
  // watched flights a week. Takes precedence over aviationstack when both keys
  // are set.
  AEROAPI_KEY: z.string().min(1).optional(),
  AEROAPI_BASE_URL: z.string().url().default('https://aeroapi.flightaware.com/aeroapi'),
  // Fallback provider: free aviationstack key (https://aviationstack.com; mind
  // its ~100 req/month free quota — every poll below is one request).
  AVIATIONSTACK_API_KEY: z.string().min(1).optional(),
  // The free plan is HTTP-only; switch to https:// on a paid plan.
  AVIATIONSTACK_BASE_URL: z.string().url().default('http://api.aviationstack.com/v1'),
  FLIGHT_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  // FALLBACK poll pace for a flight watch, used only while no departure time is
  // known. Live pacing is otherwise ADAPTIVE (status.ts adaptivePollMinutes):
  // ~3h when departure is >12h away, hourly inside 12h, every 15 min in the
  // final hour and in the air — cancellations are rare news far out, so the
  // slow tiers are what make a watch affordable on a metered feed.
  FLIGHT_WATCH_INTERVAL_MINUTES: z.coerce.number().int().positive().default(60),
  // Cap on active flight watches per chat so one chat can't drain the quota.
  FLIGHT_WATCH_MAX_PER_CHAT: z.coerce.number().int().positive().default(4),
  // Watch lifetime when no flight date was named (a dated watch expires two days
  // after its date instead — long enough to cover a reschedule to the next day).
  FLIGHT_WATCH_EXPIRES_HOURS: z.coerce.number().int().positive().default(48),
  // A departure/arrival move smaller than this (minutes) is feed jitter, not a
  // reschedule worth waking the chat for. Small moves accumulate against the
  // baseline, so a slow creep still notifies once it crosses this total.
  FLIGHT_DELAY_NOTIFY_MINUTES: z.coerce.number().int().positive().default(10),
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
  // Calendar connection («календарь»): a chat links its Google Calendar by the
  // SECRET iCal (ICS) address (Google Calendar → настройки календаря →
  // «Секретный адрес в формате iCal») — read-only by construction, no OAuth. A
  // poller caches upcoming events per chat; a planner turns them into smart
  // reminders (evening digest for tomorrow, morning digest for today, a ping
  // shortly before each event) and the calendar_events tool answers «что у меня
  // завтра». Events are strictly per-chat — a calendar only ever surfaces in the
  // chat it was connected to.
  ENABLE_CALENDAR: boolish.default(true),
  // How often each calendar feed is re-fetched.
  CALENDAR_FETCH_MINUTES: z.coerce.number().int().positive().default(30),
  // Hard cap (ms) on a single feed fetch.
  CALENDAR_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  // How far ahead events are cached (and how far calendar_events can see).
  CALENDAR_HORIZON_DAYS: z.coerce.number().int().positive().default(14),
  // How many upcoming events the assistant context block shows per turn (the
  // calendar_events tool reads the full cached window; this is the per-turn
  // token budget).
  CALENDAR_CONTEXT_EVENTS: z.coerce.number().int().positive().default(5),
  // Local hour the «завтра у тебя …» evening digest goes out (chat timezone).
  CALENDAR_EVENING_HOUR: z.coerce.number().int().min(0).max(23).default(21),
  // Local hour the «сегодня у тебя …» morning digest goes out.
  CALENDAR_MORNING_HOUR: z.coerce.number().int().min(0).max(23).default(8),
  // An event starting before this local hour counts as EARLY: the evening digest
  // flags it and the advice line leans into prep («собери вещи с вечера»).
  CALENDAR_EARLY_HOUR: z.coerce.number().int().min(0).max(23).default(10),
  // Minutes before a timed event to send the «скоро …» ping.
  CALENDAR_SOON_MINUTES: z.coerce.number().int().positive().default(60),
  // Same ping for TRAVEL events (flights/trains/airport-shaped titles): they
  // need a runway, not a heads-up — at T-60 a flight reminder is a missed
  // flight. Detected deterministically (isTravelEvent in calendar/notice.ts).
  CALENDAR_SOON_TRAVEL_MINUTES: z.coerce.number().int().positive().default(180),
  // Cap on connected calendars per chat.
  CALENDAR_MAX_PER_CHAT: z.coerce.number().int().positive().default(4),
  // Cheap model that writes the one advice/quip line on top of a reminder digest
  // (the event list itself is rendered deterministically — the model can't touch
  // the times/titles).
  ANTHROPIC_CALENDAR_MODEL: z.string().default('claude-haiku-4-5-20251001'),
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
