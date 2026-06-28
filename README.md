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

Parsing and receipt OCR use **Claude** (`claude-sonnet-4-6`, vision). Splid is integrated
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
  cheap model, then picks up that lingo in its own replies. View/reset per chat with
  `/slang` (`/slang clear`).
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
| `ANTHROPIC_MODEL` | no | `claude-sonnet-4-6` | Model id |
| `OPENAI_API_KEY` | no | — | Enables voice-message transcription (OpenAI audio API); unset → voice notes ignored |
| `OPENAI_TRANSCRIBE_MODEL` | no | `whisper-1` | Transcription model |
| `OPENAI_BASE_URL` | no | `https://api.openai.com/v1` | Override for an OpenAI-compatible endpoint |
| `ENABLE_HUMOR` | no | `false` | Rewrite the **tone** of plain-chat replies via a cheap OpenAI model (facts preserved; factual/tool answers untouched). Needs `OPENAI_API_KEY` |
| `OPENAI_HUMOR_MODEL` | no | `gpt-5-mini` | Model used for the humorizer pass (and the expense quip) |
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
· reminders: `/tasks` `/canceltask <id>` · lexicon: `/slang` (`/slang clear`)
· expense dictionary: `/trata` (`/trata <word>`, `/trata clear`)

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
