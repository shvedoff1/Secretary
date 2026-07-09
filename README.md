# Secretary — Telegram assistant (with optional Splid expenses)

A Telegram bot that works the same in private chats and groups — a general
secretary with memory. **Fork it, set three secrets, and it runs** as a clean,
neutral assistant; the personality and the niche skills are opt-in. Out of the box it:

- **answers questions and chats** (with web search) and keeps **per-chat memory**
  (preferences, context, free-form notes) — the same in DMs and groups, no setup needed;
- handles **reminders & recurring tasks** in plain language ("напомни встать через
  3 минуты", "каждое утро в 9 присылай сводку трат") — scheduled with cron + the
  chat's timezone;
- as an **optional add-on**, records **shared expenses** to **[Splid](https://splid.app)**
  from plain language, **voice messages**, or **receipt photos** (preview with ✅/✏️/❌
  before saving). This
  only kicks in once a chat connects a Splid group with `/group`; everything else works
  without it;
- is **admin-gated**: only approved users can use it, so it can't be abused.

Everything with *flavor* — the chill/surfer voice, the surf forecast, the OpenAI
humorizer/quip, the spontaneous chime-in, slang learning — ships **off by default**.
Pick a voice per chat with `/style`, and turn skills on with feature flags. See
**[Personas & optional extras](#personas--optional-extras)**.

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
- **Expense quip** *(opt-in, off by default)*: after you **confirm** an expense, a cheap
  OpenAI model appends a short joke to the bottom of the "✅ Записано" message. It's added
  after the expense is already written, so it's display-only and can never corrupt
  amounts/names. Turn on with `ENABLE_EXPENSE_QUIP=true` (needs `OPENAI_API_KEY`).
- **Lexicon learning** *(opt-in, off by default)*: the bot quietly reads every message
  and, in batches, learns the slang and distorted word-forms the chat uses (e.g. «тип»
  for «типа», «братик») via a cheap model. It only surfaces via the humorizer, so it's
  paired with `ENABLE_HUMOR`. Turn on with `ENABLE_LEXICON=true`; view/reset per chat
  with `/slang` (`/slang clear`).
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
| `BOT_LOCALE` | no | `en` | Language of the bot's own fixed strings (command replies, errors, previews, help). The assistant's generated replies always mirror the user's language regardless. `ru` reproduces the original Russian wording verbatim. One of `en\|ru` |
| `ANTHROPIC_MODEL` | no | `claude-sonnet-5` | Model id (thinking is sent disabled, so the tone/latency profile matches Sonnet 4.6) |
| `OPENAI_API_KEY` | no | — | Enables voice-message transcription (OpenAI audio API); unset → voice notes ignored |
| `OPENAI_TRANSCRIBE_MODEL` | no | `whisper-1` | Transcription model |
| `OPENAI_BASE_URL` | no | `https://api.openai.com/v1` | Override for an OpenAI-compatible endpoint |
| `ENABLE_HUMOR` | no | `false` | Rewrite the **tone** of plain-chat replies via a cheap OpenAI model (facts preserved; factual/tool answers untouched). Needs `OPENAI_API_KEY` |
| `OPENAI_HUMOR_MODEL` | no | `gpt-5.5` | Model used for the humorizer pass (and the expense quip). Set to a cheaper model (e.g. `gpt-5-mini`) to cut cost |
| `OPENAI_REASONING_EFFORT` | no | `low` | Reasoning effort sent to the humorizer/quip model. gpt-5-family models reason before answering by default (the reason the pass felt far slower than Claude); `low` keeps it quick while still doing a real rewrite (`minimal` came out lazy — near-verbatim). Use `none` to omit the field for non-reasoning models (e.g. gpt-4o-mini). One of `none\|minimal\|low\|medium\|high` |
| `OPENAI_HUMOR_TIMEOUT_MS` | no | `20000` | Hard cap (ms) on a single humorizer/quip OpenAI call; on timeout the humorizer falls back to the original text and the quip is skipped |
| `ENABLE_EXPENSE_QUIP` | no | `false` | Append a short OpenAI joke to the "✅ Записано" confirmation after an expense is confirmed (display-only, added post-write, so it can't corrupt amounts/names). Needs `OPENAI_API_KEY`; reuses `OPENAI_HUMOR_MODEL` |
| `DEFAULT_PERSONA` | no | `neutral` | Default voice/style for chats that haven't run `/style`. A preset id from `src/persona/presets.ts` (`neutral`, `chill`, `formal`, or your own) |
| `DEFAULT_CURRENCY` | no | `EUR` | ISO 4217, used when unstated |
| `DATABASE_PATH` | no | `./data/bot.sqlite` | SQLite file |
| `LOG_LEVEL` | no | `info` | pino level |
| `PENDING_TTL_MINUTES` | no | `30` | Preview expiry |
| `CONVERSATION_HISTORY_LIMIT` | no | `20` | Turns kept as context |
| `CONVERSATION_HISTORY_MAX_AGE_HOURS` | no | `12` | Drop dialogue history older than this so old tangents expire |
| `ENABLE_WEB_SEARCH` | no | `true` | Needs outbound internet |
| `ENABLE_SURF` | no | `false` | Optional skill: `surf_forecast` tool (Open-Meteo marine API, no key). Host must allow outbound HTTPS to `*.open-meteo.com` |
| `ENABLE_CHIME` | no | `false` | Spontaneous chime-in: occasionally revive a long-quiet group chat on its own |
| `DEFAULT_TIMEZONE` | no | `UTC` | IANA fallback for reminders until a chat sets its own |
| `ENABLE_LEXICON` | no | `false` | Learn the chat's slang from messages (surfaces only via the humorizer) |
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
· reminders: `/tasks` `/canceltask <id>` · style: `/style` (`/style <id>`)
· lexicon: `/slang` (`/slang clear`) · expense dictionary: `/trata` (`/trata <word>`, `/trata clear`)

## Personas & optional extras

A fresh fork talks in a **neutral** voice, in **English**, and enables no flavor.
The bot's fixed UI strings are localized (`BOT_LOCALE=en|ru`; `ru` reproduces the
original Russian wording) — the assistant's *generated* replies always mirror the
user's own language regardless. Add a locale by extending `src/i18n/catalogs/`.
Two more dials let each deployment (and each chat) add personality without touching
the core:

- **Personas (`/style`)** — pick a voice per chat. Presets live in code
  (`src/persona/presets.ts`): `neutral` (default), `chill` (laid-back, light slang,
  a bit of backbone in banter), `formal` (professional, no slang). `/style` lists them
  and marks the active one; `/style chill` selects and pins it for that chat. Set the
  fleet-wide default with `DEFAULT_PERSONA`. **Add your own** by appending a preset to
  the array — id, name, description, and a `style` block of tone directives. The style
  text is injected per-request (not into the cached system prompt), so switching is
  instant and cache-safe. Personas change *how the bot talks*, never *what it can do*.
- **Optional skills & flavor (feature flags)** — each is off by default and flipped on
  in `.env`: `ENABLE_SURF` (surf/wave forecasts), `ENABLE_HUMOR` + `ENABLE_LEXICON`
  (OpenAI tone-rewrite that speaks the chat's learned slang), `ENABLE_EXPENSE_QUIP`
  (a joke under a confirmed expense), `ENABLE_CHIME` (spontaneous revival of a dead
  chat). Skills gate both their tool and their slice of the system prompt, so a fork
  that leaves them off never pays their prompt/token cost.

## Architecture

```
bot/        grammY handlers, triggers, auth gate, preview/confirm flow, /style
llm/        Claude assistant (tool-use router): record_expense | remember | edit_memory |
            learn_expense_pattern | edit_lexicon | schedule_task | surf_forecast | add_poi |
            spending_report | web_search. Neutral core prompt + opt-in skill fragments
persona/    selectable voice/style presets (neutral | chill | formal | your own)
surf/       surf_forecast skill (Open-Meteo; the ONLY place that API is touched)
spending/   spending_report skill (reads expenses/balances back from the provider)
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
