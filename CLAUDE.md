# Secretary — project notes for Claude

Telegram expense/assistant bot. TypeScript (ESM, Node 22+), grammY, better-sqlite3,
Anthropic SDK. Splid behind a pluggable provider interface.

## Working agreements

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
  `chat_lexicon`, which is fed back into the assistant context so the bot adopts the chat's
  lingo. Managed per chat with `/slang` (`/slang clear`); a background flush in `index.ts`
  covers chats that went quiet before filling a batch.
- `src/llm/` — Claude assistant (tool-use router): `record_expense | remember |
  schedule_task | surf_forecast | web_search`. Tools in `tools.ts`, Zod + JSON schemas
  in `schema.ts`, system prompt + context block in `prompts.ts`. `humorize.ts` is an
  optional tone-only post-pass (OpenAI, off by default via `ENABLE_HUMOR`): it rewrites
  ONLY plain-chat replies (`humorizable` = no tool was used) to be funnier, never factual
  or tool answers, and falls back to the original text on any failure. OpenAI is reached
  by plain `fetch` (no SDK), mirroring `transcribe.ts`.
- `src/surf/` — `surf_forecast` skill: fetches wave/wind from Open-Meteo (the only place
  that API is touched, mirroring the splid-js rule) and formats a per-spot summary. The
  model supplies candidate spots + coords; the handler stays live in the scheduler so a
  recurring evening task can post "where to go tomorrow".
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
- Model is configurable via `ANTHROPIC_MODEL` (default `claude-opus-4-8`).
