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
  `chat_lexicon`. The learned slang is applied by the OpenAI **tone passes** (NOT Claude —
  Claude sees clean history/context, since slang is a voice concern, not a factual one).
  There are TWO of them and they never both run on one reply: the **humorizer**
  (`buildHumorSystemPrompt`) carries the lexicon on plain-chat replies it rewrites, and
  the **slang pass** (`src/llm/slang.ts`) covers everything the humorizer is banned from —
  tool/factual answers, money answers, chats with humour switched off. The slang pass is
  vocabulary-only (no jokes, no re-ordering, structure preserved) and its output is
  checked by `factsPreserved` — every number/URL/@handle must survive character-for-character
  or the rewrite is thrown away and the original ships, which is what makes it safe on
  exact answers (dota cards, surf forecasts, digests). Slang has its OWN switch,
  independent of `/humor`: global `ENABLE_SLANG` (default on, needs an OpenAI key) plus
  per-chat `/slang [<chatId>] on|off` → `chat_settings.slang_disabled` (migration 022,
  admin-only, default on). Off = neither pass speaks the chat's lingo (learning keeps
  running); it's read through ONE helper, `lexicon.repo.ts` `getVoiceLexicon`, which every
  call site (live reply, scheduler, spending digest) uses so the switch can't be honoured
  in one place and forgotten in another. Tutor chats never get slang. The gate is a pure
  `classifySlangDecision` (humorized → already-toned → disabled → no-lexicon → sent),
  logged per reply as `slang gate` next to the `humorizer gate` line. Text whose producer
  already ran a tone pass (the spending digest) is marked `toned: true` on
  `AssistantResult` so it isn't rewritten twice. `/humor <chatId> on|off`
  (`chat_settings.humor_disabled`, migration 018) still gates the JOKES — the live
  tone-pass, humour tasks (trumps `scheduled_task.humor`), the spending-digest rewrite and
  the expense quip (`prepareQuip` takes the chatId); the /ping lesson is neither pass and
  is unaffected. Managed per chat with `/slang` (`/slang clear`, `/slang on|off`); admins
  can inspect/reset/switch another chat from the DM with `/slang <chatId>` /
  `/slang <chatId> clear` / `/slang <chatId> on|off`,
  and `/chat <chatId>` shows a chat's slang state + count even for non-Splid chats. The MEANING
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
  riff on it too) and fed in as context. Off globally via `ENABLE_CHIME=false`, or
  per chat with the admin `/chime <chatId> on|off` (`chat_settings.chime_disabled`,
  migration 017, checked in `armChime`). The random auto-reactions (`reactions.ts`,
  ~10% positive emoji) have the same per-chat switch: `/react <chatId> on|off`
  (`chat_settings.reactions_disabled`, migration 019, checked in `maybeAutoReact`
  after the probability roll).
- `src/llm/` — Claude assistant (tool-use router): `record_expense | remember |
  edit_memory | learn_expense_pattern | edit_lexicon | set_rule | schedule_task |
  surf_forecast | add_poi | spending_report | web_search`. `remember` pins a fact verbatim and can
  SUPERSEDE contradicted facts (its `replaces` arg → the handler fuzzy-matches and
  removes them first, so a correction overrides instead of coexisting; the model pushes
  back once before overriding — prompt-driven). `edit_memory` fixes an existing fact in
  place (fuzzy `find` → overwrite with `replace`). Explicit/pinned chat facts get their
  own guaranteed context budget (`MEMORY_CONTEXT_PINNED`, separate from the rotating
  `MEMORY_CONTEXT_CHAT`) so a remembered fact always reaches the model.
  Memory is TWO-TIER: the weighted working set above is injected into every turn (a few
  dozen lines, bounded by the `MEMORY_CONTEXT_*` budgets), while the STORE holds
  everything (`MEMORY_MAX_ITEMS`, default 2000 — storage costs no tokens, only the
  injection does) and is reached on demand with the `recall_memory` tool
  (`makeRecallMemoryHandler` in `flows/assist.ts` → `searchMemory` in
  `memoryItem.repo.ts` → the pure ranker in `src/util/memorySearch.ts`). Ranking is
  RELEVANCE-first with weight only breaking ties — the working set already covers
  "what's salient now", so the deep tier exists precisely to surface the decayed fact
  that actually answers the question. Matching is per-token exact > prefix > shared
  5-char stem (Russian inflects endings), over content AND subject, so «когда у Гоши
  днюха» finds a user-scoped fact whose text never repeats the name; `about` alone
  answers «что ты знаешь про X» by weight. Deliberately NOT FTS5 (unlike `src/dota/`):
  memory rows are constantly inserted/reinforced/edited/pruned, and an index that
  drifts returns wrong facts — scoring a few thousand short strings in JS is
  microseconds and can't drift. The context block carries a one-line
  hint of how many facts are hidden (`pushMemoryDepthHint`), without which the model
  reads the shown sections as the whole of memory and answers «не помню» for a fact
  one call away. `recall_memory` is read-only, so unlike remember/edit_memory it stays
  on for scheduled runs and tutor chats; results are capped by `MEMORY_RECALL_LIMIT`
  (they land in the context as tokens). Bulk cleanup of
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
  by plain `fetch` (no SDK), mirroring `transcribe.ts`. `slang.ts` is its sibling for
  every reply the humorizer skips (see the slang notes under `src/bot/`): same transport
  and knobs (`OPENAI_HUMOR_MODEL`, reasoning effort, timeout), but a vocabulary-only
  prompt plus the deterministic `factsPreserved` guard, so it can run on exact answers.
  Both live and scheduled replies run humorizer-then-slang as an either/or. Timer tasks opt into this pass
  per-task: `schedule_task` takes a `humor` flag (stored on `scheduled_task.humor`,
  toggled later with `/taskhumor <id> on|off`), and the scheduler humorizes a firing
  task's plain-chat output only when that flag is set (still subject to the same
  `humorizable` + `ENABLE_HUMOR` gating), DMing the admin the pre-OpenAI "before" via
  `humorizeWithPreview` just like the live flow — passing the chat's lexicon to that call
  so its voice matches the chat. Recent chatter is still injected into a humour task's
  Claude context (see `scheduler.ts`); plain/factual tasks stay context-clean.
- Chat RULES (`chat_rule`, migration 023, `chatRule.repo.ts`) — standing behaviour
  instructions in the user's own words («все голосовые очищай от слов-паразитов и
  скидывай расшифровку», «отвечай короче»). They are NOT memory: memory is what the
  bot knows, a rule is what it must DO, so they render at the TOP of the context block
  as a numbered order list («STANDING ORDERS … they outrank your default style») in
  every mode, tutor included, and in scheduled runs too. Because they cost tokens on
  every turn the list is capped (`CHAT_RULES_MAX`, default 30) and exact duplicates are
  refused. Set in plain words via the `set_rule` tool (add/remove; off for scheduled
  runs — a firing task must not rewrite how the bot behaves) or explicitly with
  `/rules [<chatId>] [add <текст>|del <N>|clear]` (admin-only for another chat, same
  parsing as `/slang`). Removal matches forgivingly (exact → unique containment) and an
  AMBIGUOUS quote resolves to nothing rather than dropping the wrong rule. The
  «голосовые» class of rule needs the model to know the channel: `runAndRespond`
  prefixes a voice transcript with `VOICE_TRANSCRIPT_MARKER` (exported from
  `prompts.ts`, explained verbatim in `SYSTEM_PROMPT` — a test pins the two together),
  and the prompt says to answer its content normally UNLESS a rule asks for more.
  Same shape for FORWARDED messages (`src/bot/forwarded.ts`): `forwardOrigin` reads
  `forward_origin` (with the legacy `forward_from*` fields as a fallback) and
  `runAndRespond` prefixes the turn with `FORWARDED_MESSAGE_MARKER (источник: …)`
  — as its own leading text block for a photo turn — plus a `[переслано]` tag on
  the stored history turn, so the next turn doesn't read the forward as the
  sender's own words. Both markers can stack (a forwarded voice note). The prompt
  says a forward is someone else's words — never the sender's action/spend unless
  they say so — and that a rule about «пересланные» wins. PASSIVE learning is the
  one part a rule can NOT reach (the lexicon/memory extractors are their own cheap
  batched passes and never see the rules), so it is gated deterministically:
  `passiveLearningAllowed` makes both `onMessage` and `onVoice` skip forwards
  unless `LEARN_FROM_FORWARDS=true` — a forwarded article's facts and a forwarded
  meme's words otherwise land in the chat's memory and voice.
  FORWARD BATCH (`src/bot/forwardBuffer.ts`): forwards are NOT answered one by
  one — onMessage/onVoice/onPhoto park each in a per-chat in-memory pack (text /
  ready transcript / photo caption + origin label) and mark the message with the
  🫡 reaction. The pack is consumed by whichever comes first: an ADDRESSED ask
  («сделай саммари») — `runAndRespond` drains it (opt-in `includeForwardBatch`,
  set only by the real entry points so a chime/reword can never swallow it),
  prepends `renderForwardBatch` to the turn and stores only a compact
  `[+пачка из N пересланных]` history tag (the pack would blow the history
  window); OR a TAP on the 🫡 mark — `onForwardReaction` (message_reaction
  update; `allowed_updates` in index.ts must list it explicitly, and in GROUPS
  Telegram only delivers reaction updates to admin bots) runs the pack with a
  "no typed request" instruction, which is also the no-typing answer path for a
  single forwarded voice note; OR the sliding TTL (`FORWARD_BUFFER_TTL_MINUTES`,
  default 10) expires it silently, clearing the marks. Capped by
  `FORWARD_BUFFER_MAX` (default 50, overflow counted and admitted to the model);
  `ENABLE_FORWARD_BUFFER=false` restores per-message processing. Buffering also
  keeps forwards out of the auto-expense scan and the DM reply-to-everything
  path, and a forward whose TEXT happens to mention the bot's name is still
  buffered (the words are the original author's, not the sender's).
- `src/watch/` — page watches («вотчеры»): poll a URL until an awaited EVENT appears
  on it, then notify the chat and disarm — «следи за https://kinomax.ru/… и напиши,
  когда появятся сеансы Титана». Created in plain words via the `watch_page` tool
  (url + `condition` — the precise awaited event — + `keywords`), listed in the
  context block ("Active page watches") so the model never duplicates one, managed
  with `/watch` (`/watch del <id>`, `/watch check <id>` forces a poll now). The
  poller (`poller.ts`, driven by the same minute tick as the scheduler in
  `index.ts`) fetches the page (`fetch.ts` — the only place watch HTTP happens,
  browser-ish UA), and keeps the polling cheap with two gates before any LLM call:
  a KEYWORD gate (no target keyword in the raw html => the event can't have
  happened; raw html so JS-rendered pages whose schedule lives in embedded JSON
  state still match) and an unchanged-page hash (the model-facing excerpt —
  visible text + raw-HTML windows around keyword hits, `extract.ts`, pure — is
  hashed; same hash as last poll => same verdict, skip). Only a changed,
  keyword-bearing page reaches `src/llm/watchCheck.ts` (Haiku, temperature 0,
  strict "concrete evidence only" prompt so a «скоро в кино» teaser never fires;
  any malformed/failed verdict reads as not-met — fail-safe). On met: notify FIRST,
  then disarm (a failed send retries next poll), and record the post as an
  assistant turn so follow-ups have context. Watches expire (default 2 weeks, with
  a farewell note), fetch failures warn the chat exactly once (at 10 consecutive),
  and a per-chat cap (default 10) bounds the poll loop. Off globally via
  `ENABLE_WATCH=false`; the tool is off for scheduled runs (no self-spawning) and
  tutor chats. Knobs: `WATCH_INTERVAL_MINUTES` (default 15, clamped ≥5),
  `WATCH_EXPIRES_DAYS`, `WATCH_MAX_PER_CHAT`, `ANTHROPIC_WATCH_MODEL`.
- `src/dota/` — `dota_lookup` skill: CURRENT-patch Dota 2 reference (heroes, items,
  abilities, talents, facets, patch notes) so the dota persona never answers item/hero
  numbers from stale training data. A nightly job (`sync.ts`, driven by the hourly tick
  in `index.ts`, plus a catch-up on startup when the base is empty) crawls Valve's
  keyless datafeed and stores READY TEXT CARDS in SQLite (migration 021: `dota_entity` +
  `dota_alias` + an FTS5 `dota_fts` + single-row `dota_sync_state`), so a lookup at chat
  time is a local read with no network latency. `feed.ts` is the only place dota2.com /
  dotaconstants HTTP happens (mirrors the splid-js/Open-Meteo rule) — note the feed's
  quirks: ids can NOT be batched (a full crawl is ~550 requests, hence "at night"),
  `language=russian` localises descriptions but NOT names (cards keep English names; the
  model must pass canonical English), and `facets` comes back EMPTY for every hero, so
  facets + resolved talent values come from odota/dotaconstants (labelled in the card as
  possibly lagging). Descriptions are TEMPLATES (`%blink_range%`, `{s:bonus_x}`, `%%`)
  resolved against `special_values` in `template.ts` (pure, fixture-tested — a wrong
  substitution is a wrong number in the chat); `card.ts` renders them (also pure). The
  crawl is skipped when one cheap `patchnoteslist` request shows the patch hasn't moved,
  and a >20% feed-failure rate ABORTS the swap so a bad night can't replace a good base
  with a gutted one (the whole swap is one transaction). `lookup.ts` resolves names via
  `dota_alias`, falls back to FTS "did you mean" rather than letting the model invent,
  attaches the entity's patch notes automatically, and degrades to digests past a char
  budget. Tool is exposed ONLY in `dota` mode chats (keeps every other chat's cached tool
  prefix untouched) and stays on for scheduled runs. Admin `/dota` (status), `/dota sync`
  (force rebuild — runs DETACHED so the ~5-minute crawl doesn't freeze the admin's
  DM behind `sequentialize`), `/dota <название>` (preview the stored card). Patch
  cards are keyed by FEED ID (`patch:item:<ability_id>`), never by display name:
  names are not unique (Dagon 1-5), and `UNIQUE (kind, key)` inside the one-shot
  swap transaction means a single collision would take the whole base down —
  `replaceDotaEntities` also drops repeated keys as a last-resort guard. Off via
  `ENABLE_DOTA=false`; knobs `DOTA_LANGUAGE`, `DOTA_SYNC_HOUR_UTC`,
  `DOTA_SYNC_MIN_INTERVAL_HOURS`, `DOTA_SYNC_MAX_AGE_HOURS`, `DOTA_SYNC_RETRY_HOURS`
  (backoff for an EMPTY base, so a failing feed isn't re-crawled every hourly tick),
  `DOTA_FEED_DELAY_MS`, `DOTA_FETCH_TIMEOUT_MS`, `DOTA_MAX_CARDS`.
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
- Expense-only scan: a group message that was NOT addressed to the bot but looks like
  a spend (`routeMessage` → `auto-expense`, `addressed:false`) can only end in a
  `record_expense` preview or in silence — any text it produces is dropped. So that run
  is stripped to exactly that job (`expenseOnly` on `AssistantContext`, set in
  `runAndRespond` from `!addressed`): `record_expense` is the ONLY tool, and the context
  block carries no memory / reminders / watches / places (chat RULES stay — they're
  orders). Memory there wasn't just dead weight, it MISFIRED: a remembered «я — Швед»
  had the model take the payer from memory instead of from the sender («Швед купил
  круассан», sent by Андрей Шведов) and reason about the identity out loud. Cutting the
  tools also stops an unaddressed scan from quietly WRITING (`remember`, `set_rule`,
  `schedule_task`) on a message nobody sent to the bot. On the ADDRESSED path memory
  stays (it's needed for «дели как в прошлый раз»), and two static prompt rules keep it
  out of identity: «MEMORY NEVER NAMES THE PAYER» (the payer comes from this message;
  «я» stays «я», it resolves to the sender deterministically) and «MEMORY NEVER DECIDES
  WHO IS SPEAKING» (facts are stored in the chat's own words, so «я» inside an
  «About X» block means X — «Message sender» always wins). `rewordPending` was already
  memory-free.
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
  users pass. Two whole-chat exemptions: a Splid-connected group, and a chat the admin
  explicitly TRUSTED (`chat_settings.trusted`). Trust is granted by picking a mode from
  the "bot was added" DM notification (`src/bot/handlers/onBotMembership.ts` — a
  `my_chat_member` handler registered BEFORE the gate, so the join event from an
  unapproved adder still reaches the admin; buttons `m:*` set mode+trust and greet the
  chat in persona) or by `/mode` (setting a mode trusts the chat), and is managed with
  `/trust <chatId> on|off`. Removal of the bot from a chat auto-revokes trust. The admin
  manages the per-user whitelist from the DM:
  `/whitelist` lists everyone, `/allow <id> [имя]` opens access proactively (upsert — works
  for ids the bot has never seen, unlike the old UPDATE-only `/approve`), `/deny <id>`
  closes it; `/request` + inline approve buttons still work for inbound requests.
- Chat modes (`chat_settings.mode`, admin `/mode <chatId> <режим>`) are described ONCE in
  `src/modes.ts` — the registry (label, description, greeting, and the four
  personality stances `humor`/`slang`/`chime`/`reactions`) that the picker keyboard,
  `/modes`, `/mode`, `/chat`, the join-DM greeting and every feature gate read from,
  so adding a mode is one entry plus a system prompt rather than a dozen
  `Record<ChatMode, …>` maps drifting apart. The gates are `modeAllowsHumor/Slang/
  Chime/Reactions`, applied ON TOP of the per-chat switches (`/humor`, `/slang`,
  `/chime`, `/react`) — both must allow a feature — at every call site that can
  produce tone: the live reply, the scheduler, the expense quip and the spending
  digest. SELECTOR FLOW: the "bot was added" DM (`onBotMembership.ts`) shows the
  picker built from the registry with an «ℹ️ Что за режимы?» button (`m:?:<chatId>`)
  that renders the descriptions and keeps the picker on screen — look, then choose;
  `/modes` prints the same card, and `/mode <chatId>` with no mode replies with the
  buttons. Picking a mode still trusts the chat.
  `assistant` («ассистент») is the calm one: the FULL secretary skill set with the
  persona removed — `ASSISTANT_SYSTEM_PROMPT` is a static persona-override suffix on
  `SYSTEM_PROMPT` (like dota, so behaviour rules are shared and the prefix stays
  cacheable) that bans jokes/surfer slang and points behaviour at the chat's RULES.
  It keeps memory + the learned slang (that's how it "adapts to the chat") but never
  humorizes, never chimes in and never auto-reacts. `dota`
  keeps the FULL secretary feature set (memory, humor, slang, chime, reminders, tools) but
  swaps the persona for a schoolkid who fancies himself a Dota 2 teacher —
  `DOTA_SYSTEM_PROMPT` is a static persona-override suffix on top of `SYSTEM_PROMPT`
  (so behaviour rules are shared and the string stays prompt-cacheable), the OpenAI
  humorizer gets a matching `persona: 'dota'` variant (schoolkid-sensei rewrite instead of
  the surfer), and the chime in a dota chat is told to weave ONE concrete Dota tactic into
  its revive quip (see `fireChime`). Dota mode is also the ONLY mode that gets the
  `dota_lookup` tool (`src/dota/`), and its prompt makes calling it mandatory before
  answering with any concrete game data — the persona's whole shtick is being a sensei,
  so quoting last patch's item price is the one failure that isn't funny. Because
  `dota_lookup` is a tool call, those replies are `humorizable:false` (like surf/spending
  tool answers) — Claude's own dota persona carries the tone, the OpenAI pass stays out
  of the numbers. The mode also ships the deterministic `/ping` roll
  call: named per-chat ping lists (`ping_list_entry`, `src/db/repos/pingList.repo.ts`) —
  `/ping` pings the default «dota» list, `/ping <список>` a named one, edited via
  `/ping add|del [список] @ник …`, `/ping lists`, `/ping clear [список]`; `/ping show
  [список]` is the dry run — it renders the roster with zero-width-space-defanged
  mentions (`defangMention`) so nobody gets notified (lists output is defanged too).
  The ping is NOT an LLM call (must fire instantly/reliably): a canned schoolkid-sensei
  opener plus plain-text @usernames (which is what actually notifies in Telegram),
  followed by a SECOND message — an absurd "lesson" GENERATED per ping
  (`src/llm/pingLesson.ts`: OPENAI, deliberately — livelier voice, accuracy irrelevant;
  the humorizer's model/knobs via plain fetch, recent chatter from the chime's ring
  buffer as context, the canned `PING_LESSONS` pool embedded in the prompt as tone
  references and used as the deterministic fallback (also when no OpenAI key); output
  is @-defanged). Rosters can
  also be edited in plain words («добавь @vasya в основной пинг», multiple at once) via
  the `edit_ping_list` tool (any non-tutor chat, off for scheduled runs; its handler
  strips @ from confirmations so the model's reply can't re-ping people). The same tool
  carries per-member QUIET HOURS («не тегай меня до 19:00 по будням» → action `mute`
  with structured windows; `unmute` clears; the `replace` flag decides from phrasing
  whether windows REPLACE the schedule (restatement/correction) or are APPENDED with
  dedup («ещё не тегай в субботу»); absent → append, so a misread never wipes rules —
  the confirmation always echoes the RESULTING full schedule) and mention fixes
  («исправь меншн X на Y» → action `rename`/`renameTo` → `renamePingMember`: renamed in
  every list, folded into an existing target without duping, quiet hours move along —
  never remove+add). The prompt FORBIDS inventing @usernames (latin-only; a Cyrillic
  «@Имя» is a fabrication that pings nobody): unknown ник → ask once and suggest the
  person reply in the chat so their handle surfaces. Rules live in `ping_mute_rule` (migration
  016, keyed chat + normalized member, chat-wide across lists), evaluation is
  deterministic and tz-aware at /ping time (`src/util/pingMute.ts` `isMutedAt`, default
  tz Europe/Moscow), muted members are left out of the roll call with a defanged «🔕 не
  бужу» note (everyone muted → no ping at all), and `/ping show` prints the rules. For
  «меня» the sender's @username is exposed in the context block ("username for tool
  inputs"). The command
  works in any chat regardless of mode; the mode drives only persona/chime/humor.
  `tutor` flips
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
