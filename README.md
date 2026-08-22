# Secretary — Telegram assistant (with optional Splid expenses)

A Telegram bot that works the same in private chats and groups — a general
secretary with memory. It:

- **answers questions and chats** (with web search) and keeps **per-chat memory**
  (preferences, context, free-form notes) — the same in DMs and groups, no setup needed;
- handles **reminders & recurring tasks** in plain language ("напомни встать через
  3 минуты", "каждое утро ищи прогноз волн и кидай сюда") — scheduled with cron + the
  chat's timezone;
- as an **optional add-on**, records **shared expenses** to **[Splid](https://splid.app)**
  from plain language, **voice messages**, or **receipt photos** (preview with ✅/✏️/❌
  before saving). This
  only kicks in once a chat connects a Splid group with `/group`; everything else works
  without it;
- is **admin-gated**: only approved users can use it, so it can't be abused.

Parsing and receipt OCR use **Claude** (`claude-sonnet-5`, vision). Splid is integrated
behind a swappable provider interface, so other targets (Splitwise, Sheets, …) can be
added without touching the core.

## How it works

- **Expenses** are auto-detected in a group (no need to address the bot). The bot maps
  Telegram users to Splid members; the sender is the default payer and everyone is the
  default split unless the message says otherwise. Nothing is written until you tap ✅.
- **Chat**: in a group the bot replies to general questions only when you **@mention it
  or reply to its message**; in private chats it always replies. Reply to a preview
  message with a corrected sentence to re-parse the expense.
- **Memory**: `/remember`, `/memory`, `/forget`, and the bot can also save facts itself.
- **Expense dictionary (no redeploy)**: on top of the built-in spend keywords, you can
  teach the bot your chat's own expense vocabulary at runtime. Reply to a message it
  missed with «запомни, это трата» and it extracts the distinctive word(s) into the
  chat's dictionary, so future messages with that word auto-route as expenses.
  View/add/reset with `/trata` (`/trata дошик, на бензин`, `/trata clear`).
- **Voice transcript to admin**: every transcribed voice note is also DM'd to the admin
  (with the chat + sender), so flaky transcriptions can be spotted at a glance.
- **Expense quip**: after you **confirm** an expense, a cheap OpenAI model appends a short
  joke to the bottom of the "✅ Записано" message (on by default). It's added after the
  expense is already written, so it's display-only and can never corrupt amounts/names.
  Toggle with `ENABLE_EXPENSE_QUIP`.
- **Lexicon learning**: the bot quietly reads every message and, in batches, learns the
  slang and distorted word-forms the chat uses (e.g. «тип» for «типа», «братик») via a
  cheap model, then picks up that lingo in its own replies — in ALL of them, including the
  exact ones (dota cards, forecasts, spending digests): the humorizer carries the slang
  when it rewrites a plain reply, and a separate vocabulary-only slang pass covers the
  rest, swapping words while every number, link and @username is checked to have survived
  unchanged. View/reset per chat with `/slang` (`/slang clear`); switch the voice on or
  off with `/slang on|off` (admin), independently of `/humor`.
- **Chat modes**: every chat has a mode that decides the persona and how playful the bot
  is — `secretary` (the chill surfer default), `assistant` (calm helper: same skills, no
  jokes, no chime-ins, no random reactions — it still adapts via memory and the chat's
  slang), `tutor` (accuracy-first exam prep) and `dota` (schoolkid-sensei + the current-patch
  Dota base). When the bot is added to a chat, the admin gets a DM with the mode picker;
  the «Что за режимы?» button describes them all before choosing. Later: `/modes` to read
  them, `/mode <chatId>` for the same buttons, `/mode <chatId> <режим>` to set one directly.
- **Forwarded vs. written here**: the bot can tell a forwarded message from one written
  in the chat, and says so to the model («[пересланное сообщение] (источник: канал «X»)»),
  so a rule like «ничего не запоминай из пересланных» actually works — and a forwarded
  «потратил 500 на такси» is no longer read as the sender's own spend. Passive learning
  (slang + memory) skips forwards outright, since a rule can't reach those batched passes;
  set `LEARN_FROM_FORWARDS=true` to restore the old behaviour.
- **Forward batch + summary**: forward a pile of messages (text, voice, photos) and the
  bot won't answer each one — it collects them into a pack, marking every message with a
  🫡 reaction. Then either just ask («сделай саммари», «что тут важного» — in a group,
  mentioning the bot) or **tap the 🫡 reaction** on any of them to process the pack right
  away with no typing (that's also how a single forwarded voice note gets answered).
  Voice notes are transcribed as they arrive, so the summary is instant. An unclaimed
  pack quietly expires after `FORWARD_BUFFER_TTL_MINUTES` (default 10). NOTE: in groups
  Telegram only delivers reaction taps to bots that are **admins**; asking in words works
  regardless.
- **Chat recap («что тут было?»)**: the bot keeps a rolling log of what is actually said
  in a chat — every message, not just the ones addressed to it — and can summarise it on
  request: «перескажи, что было в последних 200 сообщениях», «что я пропустил», «о чём
  болтали вчера». Ask by a number of messages or by a period; the bot reads that window
  of the log and writes the recap in its usual voice, and says so when the window reaches
  further back than the log keeps. A big window (500+ messages) is handled in two tiers:
  a cheap model first compresses the older part into dense notes and only the newest
  slice stays word-for-word, so the recap really covers the whole period instead of its
  tail (`ENABLE_SUMMARY_CONDENSE=false` turns that off and falls back to truncation). The log is bounded per chat (`CHAT_LOG_KEEP_PER_CHAT`
  messages, `CHAT_LOG_RETENTION_DAYS` days), can be inspected/wiped by the admin with
  `/chatlog <chatId>` (`/chatlog <chatId> clear`), and switched off entirely with
  `ENABLE_CHAT_LOG=false`.
- **Chat rules**: standing behaviour instructions in your own words — «все голосовые
  очищай от слов-паразитов и скидывай мне расшифровку», «отвечай короче», «без эмодзи».
  Just tell the bot («с этого момента …») and it records the rule itself, or use
  `/rules add <текст>`; they are injected into every turn as orders and apply in every
  mode. List with `/rules`, drop with `/rules del <N>` / `/rules clear`.
- **Reminders**: ask in natural language and the bot creates a scheduled task (the first
  time it asks the chat for its timezone, then reuses it). Manage with `/tasks` and
  `/canceltask <id>`. A background scheduler fires due tasks every minute and posts the
  result back to the chat.

## Setup

1. **Create a bot** with [@BotFather](https://t.me/BotFather) → get the token.
   - To let the bot auto-detect expense messages in groups, disable privacy mode:
     BotFather → `/setprivacy` → your bot → **Disable**. (Otherwise it only sees
     commands, @mentions, and replies.)
2. **Find your Telegram numeric id** (e.g. via [@userinfobot](https://t.me/userinfobot)
   or the bot's `/whoami`). This is the admin.
3. **Get an Anthropic API key** at https://console.anthropic.com.
4. Copy `.env.example` → `.env` and fill it in.

### Run locally

```bash
npm install
npm run dev      # watch mode
# or
npm run build && npm start
```

### Run with Docker

```bash
docker build -t secretary-bot .
docker run --env-file .env -v "$(pwd)/data:/app/data" secretary-bot
```

The SQLite database lives in `./data` (mounted as a volume).

### Configuration (`.env`)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `BOT_TOKEN` | yes | — | From @BotFather |
| `ANTHROPIC_API_KEY` | yes | — | Claude API key |
| `ADMIN_TELEGRAM_ID` | yes | — | Admin's numeric Telegram id |
| `ANTHROPIC_MODEL` | no | `claude-sonnet-5` | Model id (thinking is sent disabled, so the tone/latency profile matches Sonnet 4.6) |
| `OPENAI_API_KEY` | no | — | Enables voice-message transcription (OpenAI audio API); unset → voice notes ignored |
| `OPENAI_TRANSCRIBE_MODEL` | no | `whisper-1` | Transcription model |
| `OPENAI_BASE_URL` | no | `https://api.openai.com/v1` | Override for an OpenAI-compatible endpoint |
| `ENABLE_HUMOR` | no | `false` | Rewrite the **tone** of plain-chat replies via a cheap OpenAI model (facts preserved; factual/tool answers untouched). Needs `OPENAI_API_KEY` |
| `OPENAI_HUMOR_MODEL` | no | `gpt-5.5` | Model used for the humorizer pass (and the expense quip). Set to a cheaper model (e.g. `gpt-5-mini`) to cut cost |
| `OPENAI_REASONING_EFFORT` | no | `low` | Reasoning effort sent to the humorizer/quip model. gpt-5-family models reason before answering by default (the reason the pass felt far slower than Claude); `low` keeps it quick while still doing a real rewrite (`minimal` came out lazy — near-verbatim). Use `none` to omit the field for non-reasoning models (e.g. gpt-4o-mini). One of `none\|minimal\|low\|medium\|high` |
| `OPENAI_HUMOR_TIMEOUT_MS` | no | `20000` | Hard cap (ms) on a single humorizer/quip OpenAI call; on timeout the humorizer falls back to the original text and the quip is skipped |
| `ENABLE_EXPENSE_QUIP` | no | `true` | Append a short OpenAI joke to the "✅ Записано" confirmation after an expense is confirmed (display-only, added post-write, so it can't corrupt amounts/names). Needs `OPENAI_API_KEY`; reuses `OPENAI_HUMOR_MODEL` |
| `DEFAULT_CURRENCY` | no | `EUR` | ISO 4217, used when unstated |
| `DATABASE_PATH` | no | `./data/bot.sqlite` | SQLite file |
| `LOG_LEVEL` | no | `info` | pino level |
| `PENDING_TTL_MINUTES` | no | `30` | Preview expiry |
| `CONVERSATION_HISTORY_LIMIT` | no | `20` | Turns kept as context |
| `CONVERSATION_HISTORY_MAX_AGE_HOURS` | no | `12` | Drop dialogue history older than this so old tangents expire |
| `ENABLE_WEB_SEARCH` | no | `true` | Needs outbound internet |
| `DEFAULT_TIMEZONE` | no | `UTC` | IANA fallback for reminders until a chat sets its own |
| `ENABLE_LEXICON` | no | `true` | Learn the chat's slang from messages and reuse it |
| `ANTHROPIC_LEXICON_MODEL` | no | `claude-haiku-4-5-20251001` | Cheap model for the extraction batches |
| `LEXICON_BATCH_SIZE` | no | `30` | Extract after this many buffered messages… |
| `LEXICON_MAX_AGE_HOURS` | no | `24` | …or once the oldest is this old, whichever first |
| `LEXICON_MAX_TERMS` | no | `40` | Learned terms fed back into context |
| `ENABLE_FORWARD_BUFFER` | no | `true` | Collect forwarded messages into a per-chat pack (🫡-marked) instead of reacting to each; `false` = old per-message behaviour |
| `FORWARD_BUFFER_TTL_MINUTES` | no | `10` | How long an unclaimed pack waits (sliding from the last forward) before quietly expiring |
| `FORWARD_BUFFER_MAX` | no | `50` | Max messages kept per pack (the pack lands in one LLM turn) |
| `LEARN_FROM_FORWARDS` | no | `false` | Let passive learning (slang + memory) read **forwarded** messages too. Off by default: a forward is someone else's words about someone else's life |
| `ENABLE_CHAT_LOG` | no | `true` | Keep a rolling per-chat log of every message (incl. the ones the bot never answers) so it can recap what was said. `false` = nothing is recorded and the `summarize_chat` tool disappears |
| `CHAT_LOG_KEEP_PER_CHAT` | no | `4000` | Max messages kept per chat |
| `CHAT_LOG_RETENTION_DAYS` | no | `30` | Drop logged messages older than this |
| `SUMMARY_DEFAULT_MESSAGES` | no | `200` | How many messages a recap reads when no count/period is named |
| `SUMMARY_MAX_MESSAGES` | no | `1000` | Ceiling on one recap |
| `SUMMARY_CHAR_BUDGET` | no | `14000` | How much transcript may reach the main model **verbatim**; a bigger window goes through the compression pass below |
| `ENABLE_SUMMARY_CONDENSE` | no | `true` | For a window that doesn't fit verbatim, compress the older part with a cheap model and keep only the newest slice word-for-word. `false` = plain oldest-first truncation |
| `ANTHROPIC_SUMMARY_MODEL` | no | `claude-haiku-4-5-20251001` | Cheap model used only for that compression (never for the recap itself) |
| `SUMMARY_TAIL_CHAR_BUDGET` | no | `6000` | Newest slice kept verbatim inside a compressed recap |
| `SUMMARY_CONDENSE_CHUNK_CHARS` | no | `20000` | Transcript per compression call |
| `SUMMARY_CONDENSE_MAX_CHUNKS` | no | `8` | Max compression calls per recap (they run in parallel); chunk × max is how far back one recap can reach |
| `CHAT_RULES_MAX` | no | `30` | Max standing chat rules per chat (they go into every turn's context) |
| `ENABLE_SLANG` | no | `true` | Speak the chat's learned slang in **every** reply — including the exact/tool answers the humorizer never touches (a vocabulary-only rewrite, discarded if any number/link/@handle changed). Independent of `ENABLE_HUMOR`; needs `OPENAI_API_KEY`, reuses `OPENAI_HUMOR_MODEL`. Per chat: `/slang on\|off` |

## In-chat setup

1. `/request` (each non-admin user) → admin approves via the inline buttons.
2. `/group <invite-code>` — connect the chat to a Splid group (the invite code from the
   Splid app). The group id is cached.
3. `/members` — see the Splid roster.
4. `/link <name|initials>` — link your Telegram account to a Splid member (admins can
   link others by replying to their message). The sender must be linked to be the
   default payer.

Then just talk:

- `я потратил 500 за такси за меня и Колю` → preview → ✅ → written to Splid.
- send a **photo of a receipt** (optionally with a caption) → preview → ✅.
- send a **voice message** (“потратил 500 за такси”) → transcribed → preview → ✅
  (needs `OPENAI_API_KEY`).
- `/remember у нас поездка в Бали` then `@bot где корт поближе?`

## Commands

`/start` `/help` `/request` · admin: `/approve <id>` `/deny <id>` · `/group <code>`
`/members` `/link …` `/whoami` · memory: `/memory` `/remember <text>` `/forget`
· reminders: `/tasks` `/canceltask <id>` · lexicon: `/slang` (`/slang clear`, `/slang on|off`)
· expense dictionary: `/trata` (`/trata <word>`, `/trata clear`)
· chat log: admin `/chatlog <chatId>` (`/chatlog <chatId> clear`)

## Architecture

```
bot/        grammY handlers, triggers, auth gate, preview/confirm flow
llm/        Claude assistant (tool-use router): record_expense | remember | schedule_task | web_search
scheduler.ts  background runner: fires due reminders/tasks every minute
core/       provider-agnostic types + ExpenseProvider interface + registry + resolver
providers/  splid/  (the ONLY place splid-js is imported)
db/         better-sqlite3 + migrations + repos
```

The expense write path is a side-effecting tool gated behind a human confirmation:
the model only *proposes* an expense; the user confirms before it is saved. Splid lives
behind `ExpenseProvider` — add a file under `providers/` and register it in
`core/registry.ts` to support another target.

> **Note:** Splid has no official API; this uses the unofficial
> [`splid-js`](https://github.com/LinusBolls/splid-js) client (group invite code →
> group id, no account). It may change — which is exactly why it's isolated behind the
> provider interface.

## Tests

```bash
npm test
```

Covers money conversion, the Splid mapping, hint resolution, the parse schema, and the
group trigger rules.

## Deployment notes

Runs as a single long-polling process (no public HTTPS/webhook needed). grammY supports
webhooks with the same handlers if you later want to scale.
