# Secretary — project notes for Claude

Telegram expense/assistant bot. TypeScript (ESM, Node 22+), grammY, better-sqlite3,
Anthropic SDK. Splid behind a pluggable provider interface.

## Working agreements

- **Always open a PR.** Every change ships as a pull request — create one for the
  working branch (don't just push the branch and stop), even when not explicitly asked.
- **Always write tests.** Every change ships with tests — new behavior gets new tests,
  bug fixes get a regression test. If you're worried a change might break something,
  that's the signal to add a test rather than skip it. Prefer fast, dependency-free
  unit tests (vitest) over none.
- Run `npm run build` and `npm test` before committing; both must be green.
- Keep providers behind `ExpenseProvider` (`src/core/provider.ts`); `splid-js` is only
  imported under `src/providers/splid/`.

## Layout

- `src/bot/` — grammY handlers, commands, triggers, auth gate, preview/confirm flow.
  `flows/lexicon.ts` drives passive "lexicon learning": every incoming message is buffered
  (`chat_lexicon_sample`), and in batches (N messages or once a day, whichever first) a
  cheap model (`src/llm/lexicon.ts`, Haiku) extracts the chat's slang/distorted words into
  `chat_lexicon`. The learned slang is fed to the OpenAI **humorizer** (NOT Claude): the
  tone-pass adopts the chat's lingo while Claude sees only clean history/context (slang is
  a voice concern, not a factual one — see `src/llm/humorize.ts` `buildHumorSystemPrompt`).
  Consequence: slang only surfaces when `ENABLE_HUMOR` is on and the reply is humorizable
  (plain chat, no tool, not money). Managed per chat with `/slang` (`/slang clear`); admins
  can inspect/reset another chat from the DM with `/slang <chatId>` / `/slang <chatId> clear`,
  and `/chat <chatId>` shows a chat's slang count even for non-Splid chats. The MEANING
  of a learned word can be corrected by just telling the bot ("поменяй значение у X на Y")
  — the `edit_lexicon` tool (see `src/llm/`). A background
  flush in `index.ts` covers chats that went quiet before filling a batch.
  `flows/chime.ts` drives the spontaneous "chime-in": to keep group chatter going on
  its own without talking over an active thread, it does NOT roll on the message
  itself. Each otherwise-ignored group message (re)arms a silence timer (`armChime`)
  and the roll is TIERED by how long the chat stays dead: at `CHIME_QUIET_SECONDS`
  (default 60s) of silence it rolls `CHIME_PROBABILITY` (default 10%); if that loses
  and the chat is still dead at `CHIME_HOUR_SECONDS` (default 1h) it rolls the higher
  `CHIME_HOUR_PROBABILITY` (default 60%) — a long-dead chat gets a much better chance
  of a revive. A win at any tier calls the assistant to continue the conversation by
  context as if pinged, and stops escalating. Any new message (any type) resets the
  silence clock via `cancelChime` in the global `bot.on('message')` middleware. Recent
  chatter is kept in an in-memory per-chat ring buffer (`src/bot/recentChat.ts` —
  `recordChatMessage`/`getRecentChat`, shared with the scheduler so a humour task can
  riff on it too) and fed in as context. Off via `ENABLE_CHIME=false`.
- `src/llm/` — Claude assistant (tool-use router): `record_expense | remember |
  edit_memory | learn_expense_pattern | edit_lexicon | schedule_task | surf_forecast |
  add_poi | spending_report | web_search`. `remember` pins a fact verbatim and can
  SUPERSEDE contradicted facts (its `replaces` arg → the handler fuzzy-matches and
  removes them first, so a correction overrides instead of coexisting; the model pushes
  back once before overriding — prompt-driven). `edit_memory` fixes an existing fact in
  place (fuzzy `find` → overwrite with `replace`). Explicit/pinned chat facts get their
  own guaranteed context budget (`MEMORY_CONTEXT_PINNED`, separate from the rotating
  `MEMORY_CONTEXT_CHAT`) so a remembered fact always reaches the model. Bulk cleanup of
  ACCUMULATED conflicts (what `/dedupememory`'s exact-match fold can't catch) is the
  admin `/reconcile <chatId>` command → `src/llm/reconcile.ts` (a one-shot Haiku pass at
  `temperature:0` so re-runs are stable, proposing deletes/merges for contradictions/stale/
  dupes) → dry-run preview → `/reconcile <chatId> apply` (`applyReconcilePlan`); it never
  changes memory without the admin confirming. `withExpenseSweep` additionally marks any
  recorded-expense line (`looksLikeExpense`) for deletion DETERMINISTICALLY, so legacy
  expenses that leaked into memory are cleared reliably rather than at the model's whim.
  Tools in
  `tools.ts`, Zod + JSON schemas
  in `schema.ts`, system prompt + context block in `prompts.ts`. `edit_lexicon`
  corrects the stored MEANING of a learned slang word (the "поменяй значение у X на Y"
  flow → `lexicon.repo.ts` `setGloss`, exact-then-unique-containment match; never
  creates a new word). Off for scheduled runs. `humorize.ts` is an
  optional tone-only post-pass (OpenAI, off by default via `ENABLE_HUMOR`): it rewrites
  ONLY plain-chat replies (`humorizable` = no tool was used) to be funnier, never factual
  or tool answers, and falls back to the original text on any failure. It also carries the
  chat's learned slang (the `lexicon` arg → `buildHumorSystemPrompt`) so the rewrite speaks
  the group's lingo, and logs the exact slang it appended at INFO (`humorizer slang → openai`)
  so what reached OpenAI is visible in the diagnose dump. OpenAI is reached
  by plain `fetch` (no SDK), mirroring `transcribe.ts`. Timer tasks opt into this pass
  per-task: `schedule_task` takes a `humor` flag (stored on `scheduled_task.humor`,
  toggled later with `/taskhumor <id> on|off`), and the scheduler humorizes a firing
  task's plain-chat output only when that flag is set (still subject to the same
  `humorizable` + `ENABLE_HUMOR` gating), DMing the admin the pre-OpenAI "before" via
  `humorizeWithPreview` just like the live flow — passing the chat's lexicon to that call
  so its voice matches the chat. Recent chatter is still injected into a humour task's
  Claude context (see `scheduler.ts`); plain/factual tasks stay context-clean.
- `src/surf/` — `surf_forecast` skill: fetches wave/wind from Open-Meteo (the only place
  that API is touched, mirroring the splid-js rule) and formats a per-spot summary. The
  model supplies candidate spots + coords; the handler stays live in the scheduler so a
  recurring evening task can post "where to go tomorrow".
- `src/spending/` — `spending_report` skill: summarises past spending (optionally
  filtered by an approximate category — "на еду", "на такси") and/or who-owes-whom for a
  Splid group, read back from the provider (`ExpenseProvider.listExpenses` +
  `getBalances`, Splid-only impl — so expenses added directly in the Splid app count too).
  The model expands the category into generous keywords (RU+EN + Splid category types)
  and `filterByKeywords` substring-matches them over each expense's title + category.
  Pure logic (range resolution, filtering, aggregation, formatting) in `report.ts`; the
  tool handler in `handler.ts`. Like `surf_forecast` it
  stays live in both the live chat flow and the scheduler, so a recurring task created via
  `schedule_task` ("сводка трат за вчера в 9 утра") produces the digest with no bespoke
  scheduling. The handler runs its output through the humorizer (the one deliberate
  exception to "humorizer skips money") and `assistant.ts` short-circuits the tool so the
  exact figures reach the user verbatim instead of being re-phrased by the model.
- Concurrency: `index.ts` polls via `@grammyjs/runner` (`run(bot)`), so updates are
  processed CONCURRENTLY — a slow LLM turn in one chat no longer blocks every other chat
  (the old `bot.start()` handled updates one-at-a-time). Per-chat ordering is kept by a
  `sequentialize((ctx) => ctx.chat?.id)` middleware registered FIRST in `bot.ts`: within a
  single chat updates still run in order (pending previews, edit-target maps, the chime
  timer and lexicon/memory buffers are per-chat mutable state, and a correction must not
  overtake the message it corrects), while different chats run in parallel.
- OpenAI post-passes (humorizer + expense quip) run on `OPENAI_HUMOR_MODEL` (default
  `gpt-5.5`) and send `reasoning_effort` (config `OPENAI_REASONING_EFFORT`, default `low`)
  so the gpt-5-family model doesn't slow-reason over a trivial tone rewrite — the main
  cause of "openai в разы дольше Клода". `low` (not `minimal`) is the default because pure
  `minimal` made the rewrite lazy (near-verbatim echoes); `none` omits the field for
  non-reasoning models. Both calls are also bounded by `OPENAI_HUMOR_TIMEOUT_MS` (default
  20s); the shared knobs live in `src/llm/openaiOptions.ts`.
- Access control: default-deny `authGate` (`src/bot/middleware/auth.ts`) — only approved
  users pass (configured groups are exempt). The admin manages the whitelist from the DM:
  `/whitelist` lists everyone, `/allow <id> [имя]` opens access proactively (upsert — works
  for ids the bot has never seen, unlike the old UPDATE-only `/approve`), `/deny <id>`
  closes it; `/request` + inline approve buttons still work for inbound requests.
- Chat modes (`chat_settings.mode`, admin `/mode <chatId> tutor|secretary`): `tutor` flips
  a chat (typically a kid's DM; its chatId = their tg id) into an accuracy-first exam-prep
  tutor for 9th grade (ОГЭ) — `TUTOR_SYSTEM_PROMPT` + minimal context block in
  `src/llm/prompts.ts`, adaptive thinking with an 8192-token budget (the one place
  reasoning is ON), tools cut to remember/edit_memory/schedule_task/web_search, and NO
  humor/slang/chime/auto-reactions (assistant returns `humorizable:false`, onMessage skips
  lexicon learning + chime, bot.ts skips auto-react). A photo in a tutor chat is a problem
  to solve, not a receipt (`handleReceiptPhoto` skips the Splid gate). The scheduler passes
  the mode too, so scheduled tasks in a tutor chat keep the persona.
- `src/scheduler.ts` — background runner; fires due reminders/recurring tasks every minute.
- `src/db/` — migrations (numbered `.sql`, applied by `migrate.ts`) + repos.
- `src/util/` — helpers (money, telegram HTML, cron schedule).
- `test/` — vitest.

## Conventions

- DB migrations are append-only numbered files in `src/db/migrations/`; the build copies
  them into `dist/`. Per-chat data is keyed by `chat_id`; not every chat has a
  `chat_config` row (only Splid-linked ones), so chat-wide settings live in `chat_settings`.
- LLM cost: the stable prefix (tool schemas + system prompt) is prompt-cached via
  `cache_control` in `assistant.ts`. Keep `SYSTEM_PROMPT` static so the cache holds.
- Model is configurable via `ANTHROPIC_MODEL` (default `claude-sonnet-5`). The assistant
  call sends `thinking: {type: 'disabled'}` explicitly: on Sonnet 5 adaptive thinking turns
  ON by default when `thinking` is omitted, which would add latency to every tool-routing
  turn and eat into the 2048-token `max_tokens` budget (thinking counts against it). Disabling
  keeps the snappy Sonnet-4.6 behaviour; flip it to `{type:'adaptive'}` + a bigger `max_tokens`
  if you ever want reasoning.
