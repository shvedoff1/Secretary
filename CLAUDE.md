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
  surf_forecast | add_poi | spending_report | summarize_chat | web_search`. `remember` pins a fact verbatim and can
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
  MEDIA (`onPhoto.ts`, `onDocument.ts`, `media.ts`, `pendingFile.ts`): a PHOTO is
  just a photo — an addressed photo always goes to the model and IT decides what
  it is (a receipt to split where Splid is connected, a problem in tutor mode, a
  screenshot to read). There is deliberately NO Splid gate on the picture: the old
  `handleReceiptPhoto` answered «Подключите группу Splid» to any photo in a chat
  with no group — in every mode, so the optional add-on grew over assistant mode.
  Two static prompt rules keep it out: «Do NOT assume every picture is a receipt»
  and «A PHOTO or a FILE is NEVER on its own a reason to bring Splid up» (both
  pinned by a test), and the Splid OFFER now fires only on expense intent in
  WORDS. History tags a photo turn `[фото]`, never `[чек]`.
  FILES («док» — `message:document`) split by whether anything was ASKED: a file
  with a caption (or dropped as a reply to the bot, or replied to with a ping) is
  read at once; a file dropped with nothing said is NOT downloaded — the bot asks
  «что с ним сделать?» with a CANNED zero-token line and PARKS the file_id in a
  per-chat slot (`pendingFile.ts`, TTL `PENDING_FILE_TTL_MINUTES`, default 5). The
  next ADDRESSED message claims the slot and becomes the instruction, so «вытащи
  суммы» is answered without a re-upload; unaddressed group chatter can never
  claim it (that's the whole point — no tokens on a file nobody asked about). An
  IMAGE sent as a file follows the PHOTO rule instead (it's a photo that skipped
  compression). `media.ts` is pure and decides what a file IS from mime+extension
  (`image`/`pdf`/`text`/`unsupported`, Telegram loves `application/octet-stream`)
  and builds the blocks: image block, base64 PDF `document` block, or inlined text
  capped at `FILE_TEXT_MAX_CHARS` with the CUT stated in the turn. Unsupported
  types and anything over `FILE_MAX_MB` are refused in one line before any
  download; forwarded files join the pack (name + caption); GIFs are skipped
  (Telegram sets `document` on animations too); off via `ENABLE_FILE_INPUT=false`.
  A file turn is its own channel — `source: 'file'` / `LogKind 'file'` (migration
  025 widens both CHECK constraints) — and counts as money context, so the
  humorizer stays off exact figures read out of a document. The turn is prefixed
  with `FILE_ATTACHMENT_MARKER` (`[вложенный файл]` + name/kind), explained
  verbatim in `SYSTEM_PROMPT` like the voice and forward markers, so a chat rule
  can key on «файлы».
- INLINE mode (`src/bot/handlers/onInlineQuery.ts`): «@бот вопрос» in ANY chat answers
  the way the bot would answer that user in their DM (chatId = their tg id: DM memory,
  mode/persona, rules, journal, recent DM history). Built around Telegram's three
  stones: (1) `inline_query` fires per KEYSTROKE and must answer in seconds, so that
  handler NEVER calls the LLM — it instantly serves one «Спросить секретаря» card whose
  message is a «⏳ думаю» placeholder, and the LLM runs only on `chosen_inline_result`
  (one event per actual send), which edits the answer in via `inline_message_id`
  (`editInlineMarkdown` in `richMessage.ts` — same rich→HTML→plain ladder as chat
  replies, and the edit clears the stub keyboard); (2) Telegram delivers
  `inline_message_id` ONLY if the sent message carries an inline keyboard — hence the
  stub «⏳» url-button on the placeholder; (3) neither event arrives without BotFather
  setup — `/setinline` + `/setinlinefeedback` at 100% (documented in README; a missing
  id is logged loudly as that misconfiguration). The run is READ-ONLY with the
  scheduler's flag set (no remember/rules/reminders/watch/poi/ping/lexicon writes — a
  one-shot posted into an unseen chat must not change state) plus `splidConnected:
  false` (no preview/confirm UI inline → no record_expense; the prompt's
  `INLINE_QUERY_MARKER` section tells the model to redirect expense asks to the DM and
  to never ask follow-ups — nobody will answer). Nothing is written back to DM
  history/logs, and tone passes are skipped. Access is STRICTER than the chat gate:
  handlers register BEFORE `authGate` (which would leave a stranger's client spinning)
  and check `isApproved` themselves — no trusted-group exemption (inline carries no
  chat id), strangers get an empty answer with a «доступ закрыт» button, an
  in-flight-per-user guard stops concurrent runs, and the chosen handler re-checks
  approval (it can be revoked between keystroke and pick). Answers are clamped under
  the 4096-char cap (`clampInlineAnswer`) and keep the question visible above the
  answer (the target chat never saw it). Off via `ENABLE_INLINE=false` (answers empty
  so clients don't spin). `allowed_updates` in index.ts must list both update types.
- `src/summary/` — `summarize_chat` skill: recap what was actually SAID in a chat
  («перескажи, что было в последних 200 сообщениях», «что я пропустил», «о чём
  болтали вчера»). It needed a new store: `conversation_turn` is the assistant's
  context window (only turns the bot took part in, pruned to a couple of dozen rows),
  the chime's ring buffer holds 12 lines in memory, and `chat_lexicon_sample` rows are
  DELETED as soon as a learning batch claims them — so nothing held the chat's own
  chatter. `chat_message_log` (migration 024, `chatLog.repo.ts`) is that raw record:
  every incoming message (text / voice transcript / photo caption, forwards tagged
  `[переслано]`) plus the bot's own posts, written through `src/bot/chatLog.ts`
  (`recordChatLog` — best-effort, never throws, trims amortised every 50 inserts) from
  onMessage/onVoice/onPhoto and from every place that posts (live reply, scheduler,
  watch poller). Bounded per chat by `CHAT_LOG_KEEP_PER_CHAT` + `CHAT_LOG_RETENTION_DAYS`;
  admin `/chatlog <chatId>` shows depth, `/chatlog <chatId> clear` wipes it; off via
  `ENABLE_CHAT_LOG=false` (which also removes the tool). Window resolution + transcript
  rendering are pure (`transcript.ts`: count-window vs local-day range, day separators,
  per-line cut, char budget that drops the OLDEST lines and REPORTS how many); the tool
  handler (`handler.ts`) reads the window and hands the transcript BACK to the model —
  deliberately NOT a short-circuit like `spending_report`, because a recap is prose, so
  the chat's persona should write it and follow-ups («а что там про рыбалку?») can be
  answered from the same window. The handler distinguishes an empty PERIOD from an empty
  LOG and always states what didn't fit, so the model never fills the gap itself. Stays
  live for scheduled runs (read-only, so «каждое утро перескажи вчерашнее» works); off
  in tutor chats and on the expense-only scan.
  ASKING FOR CONTEXT ≠ asking for a period. «Восстанови картинку/картину по истории
  чата», «подними контекст», «введи меня в курс» is the same tool, and «картинка»
  there is the picture of EVENTS, not an image file — the bot used to read it
  literally and answer «фото я не храню, доступ есть только к тексту сообщений»,
  refusing without looking at anything. Both halves of that are fixed: the routing
  (SYSTEM_PROMPT job 12 + the tool description list those phrasings, ban the «нет
  доступа к истории» refusal, and allow only a checked «тот период пуст»; the photos
  section keeps the honest one-liner for a genuinely wanted photo FILE, which is the
  one thing that can't be brought back), and the visibility — `depth.ts`
  (`chatLogDepth`, best-effort, null on any failure) feeds `buildContextBlock` a
  ONE-line hint of how many messages are on record and since when. Without it a chat
  whose journal is still empty showed nothing at all about the log, so «я вижу только
  последние сообщения» was an accurate description of the context and a wrong answer
  about what was reachable. Passed from the live flow, the scheduler and inline; null
  in tutor chats (no `summarize_chat` to follow it with) and on the expense-only scan.
  TWO TIERS by size, because «перескажи последние 500 сообщений» is several times what
  the main model should read verbatim (500 messages ≈ 35–70k chars; a flat budget showed
  only the last ~150–200 of them). A window inside `SUMMARY_CHAR_BUDGET` goes over
  untouched; a bigger one is split by `planCondense` into a verbatim TAIL
  (`SUMMARY_TAIL_CHAR_BUDGET`, the newest slice — that's what follow-ups land on) plus
  older chunks (`SUMMARY_CONDENSE_CHUNK_CHARS` × `SUMMARY_CONDENSE_MAX_CHUNKS`, filled
  from the newest end so overflow drops the OLDEST) that a cheap model compresses in
  PARALLEL (`src/llm/summarize.ts`, `ANTHROPIC_SUMMARY_MODEL`, Haiku at temperature 0 —
  notes, never a recap: this tier drops wording, not facts, since anything it invents is
  invisible to the tier above). The assembled text labels which part is notes and which
  is verbatim, and every failure mode is stated rather than hidden: chunks that failed to
  compress are a reported GAP, all-failed falls back to the truncated verbatim window,
  and overflow says the recap starts partway in. Off via `ENABLE_SUMMARY_CONDENSE=false`
  (back to plain oldest-first truncation). The handler is async because of this pass.
- `src/episodes/` — EPISODIC memory («журнал бесед»), the human-memory middle tier
  between the tiny verbatim history window (`conversation_turn`, ~20 turns) and the
  huge raw log (`chat_message_log`): the model knows WHAT past conversations were
  about without paying for their transcripts. When a chat goes quiet
  (`EPISODE_QUIET_MINUTES`, default 45) the finished session's log slice is closed
  as an EPISODE: a cheap pass (`src/llm/episode.ts`, `ANTHROPIC_EPISODE_MODEL`
  Haiku at temperature 0, defensive JSON parse) compresses it into a few lines of
  NOTES plus 2-6 lowercase topic tags → `chat_episode` (migration 027,
  `episode.repo.ts`). Boundaries are DERIVED FROM LOG TIMESTAMPS on the minute tick
  (`closer.ts` + pure `detect.ts` — NOT in-memory timers like the chime's, so they
  survive restarts and are idempotent): `MAX(ended_at)` per chat is the close
  watermark, sessions split on silence gaps, the active tail stays open, and a
  stretch under `EPISODE_MIN_MESSAGES` folds forward into the next session instead
  of becoming a noise episode. A failed summarise call leaves the session UNCLOSED
  (retry after `EPISODE_RETRY_MINUTES`) — the watermark never advances past
  unsummarised messages. What the model sees: the newest `EPISODE_CONTEXT_COUNT`
  entries render in the context block as a "Conversation journal" (labelled NOT
  verbatim; each line carries chat-local + ISO dates via `render.ts` so the model
  can hand them to `summarize_chat` for the real transcript — that's the two-hop
  «подумать и вспомнить» path); older entries are searched by `recall_memory`,
  whose handler now queries BOTH tiers (facts + `searchEpisodes` in `search.ts`,
  same scorer as memory search, relevance first / recency breaks ties). The memory
  depth hint also gained a TOPIC INDEX (`src/util/topicIndex.ts`: memory subjects
  first, then episode topics by frequency, `MEMORY_TOPIC_INDEX_MAX`) so the model
  knows what it COULD recall, not just how much is hidden. Journal + topics reach
  scheduled runs too (a firing task has no history at all); OFF on the expense-only
  scan (conversation-only context, same rule as memory) and in tutor chats
  (summarize_chat isn't exposed there, so a journal advising it would dangle).
  Admin `/episodes <chatId>` [clear]; off via `ENABLE_EPISODES=false` (and dormant
  when `ENABLE_CHAT_LOG` is off — episodes are cut from the log). Knobs:
  `EPISODE_MAX_MESSAGES` (per-close read cap; deeper backlog is worked off across
  ticks), `EPISODE_CHAR_BUDGET`, `EPISODE_MAX_PER_TICK`, `EPISODE_KEEP_PER_CHAT`,
  `EPISODE_RECALL_LIMIT`.
  Episode close also drives PROFILE CARDS (`chat_profile`, migration 028,
  `profile.repo.ts`) — "consolidation during rest": the bot's own running 2-5 line
  portrait of the chat ('' subject) and of each person (subject NOCASE-unique).
  `profileRefresh.ts` hands the cheap model (`src/llm/profile.ts`,
  `ANTHROPIC_PROFILE_MODEL` Haiku at temperature 0) the current cards + the
  just-closed episodes' notes + the top ~40 FACTS as ground truth; it returns ONLY
  the cards the session changed (omitted = kept word-for-word — re-wording is
  where drift creeps in), parse is defensive (bad JSON → old cards stand, content
  capped at `PROFILE_CARD_MAX_CHARS`), and a failed call never blocks episode
  work. The anti-drift stance: cards are DERIVED views — facts always override a
  card line, correcting memory (remember/edit_memory) fixes the card at the next
  close, `/profile <chatId> clear` regenerates from scratch, and the bare
  `/forget` reset wipes them with the memory they were distilled from. Rendered as
  the "Profile memory" section ABOVE the fact sections (flattened one line per
  card, capped `PROFILE_CONTEXT_MAX`), with static prompt rules: may LAG behind
  the latest messages, never decides who is speaking/paid. Off with memory on the
  expense-only scan, off in tutor chats, global `ENABLE_PROFILES`. Admin
  `/profile <chatId>` shows the exact stored cards.
- Memory fact KINDS (migration 028): every `chat_memory_item` is a `trait`
  (durable — the default and the old behaviour) or a `status` — a CURRENT,
  temporary state («сейчас во Вьетнаме», «болеет») the extractor now classifies
  (`kind` in its JSON; anything not explicitly status parses as trait, the safe
  default). A status decays on `MEMORY_HALFLIFE_DAYS / STATUS_HALFLIFE_DIVISOR`
  (fixed divisor 5 in `memoryWeight.ts` — the ratio matters, not another knob), so
  «во Вьетнаме» fades from the working set in days unless re-mentioned (the
  extractor's known-facts list tags statuses so a re-mention reinforces the row,
  resetting its clock — an ONGOING state stays current), and is hard-EXPIRED from
  the store after `MEMORY_STATUS_TTL_DAYS` (default 60) by the deterministic
  `expireStatuses` sweep in `flushMemory` — a stale "current state" is
  misinformation recall would still surface, not a memory. Traits and pinned
  facts never expire; `/memory` tags statuses ⏳.
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
  memory-free. The cut keys on `addressed`, and a VOICE note is always
  `addressed:true` (a transcript can be a question or a reminder, so its toolset can't
  be cut) — so on the voice path memory is still present and is fenced off by prompt
  instead: a garbled name from a transcript («Швец» for «Швед») is matched against the
  ROSTER, never against memory/profiles/journal, and the sender's own mis-heard name
  collapses to «я». `notes` is DATA (itemised prices, real ambiguity), never the
  model's reasoning — «голосовое распознало X как Y, судя по памяти чата…» in a
  preview was the visible leak; the ban is in both the prompt and the tool schema.
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
  `/trust <chatId> on|off`. Removal of the bot from a chat auto-revokes trust. A supreme
  admin manages the per-user whitelist from the DM:
  `/whitelist` lists everyone, `/allow <id> [имя]` opens access proactively (upsert — works
  for ids the bot has never seen, unlike the old UPDATE-only `/approve`), `/deny <id>`
  closes it; `/request` + inline approve buttons still work for inbound requests.
- Roles (`src/bot/permissions.ts`), deliberately FLAT — two tiers, no nesting:
  a SUPREME admin («верховный», `users.role='admin'`; `ADMIN_TELEGRAM_ID` is re-ensured
  as one on every boot, so the owner can never lock themselves out) manages every chat,
  the whitelist and PEOPLE — `/admins <chatId> add|del <tgUserId>` grants per-chat admin
  rights, `/superadmin add|del <tgUserId>` hands over/revokes the supreme role itself
  (the configured root id is protected from demotion). A CHAT admin (row in
  `chat_admin`, migration 026, `chatAdmin.repo.ts` — the user↔chat table) gets the FULL
  per-chat toolkit for exactly their chats: every command in `commands/admin.ts` plus the
  cross-chat forms of `/slang`/`/rules` and the `m:*` mode-picker callback route through
  `canManageChat` (supreme OR chat-admin row), DM-only as before. Granting either role
  also whitelists the user (rights without gate access would be useless); revoking a role
  never touches access. `/chats` is the manager's home screen: a chat admin sees exactly
  their chats, a supreme admin every known chat (chat_config ∪ chat_settings), each with
  tap-to-copy `<code>` commands (chat titles are recorded best-effort into
  `chat_settings.title` from `my_chat_member` and incoming group messages, so lists show
  names, not bare ids — same in `/chat <id>`, whose whole footer is copyable commands).
  `/help` renders three tiers (user / chat admin / supreme); `/whoami` shows the caller's
  role and tap-to-copy ids. The assistant can answer «кто ты и чей ты?»: the context
  block carries a "Bot admins" line (`botAdminLabels` — supremes first, then the chat's
  admins) and the "Who you are" SYSTEM_PROMPT section (both pinned by a test) tells the
  model to politely name who it reports to and never invent admins.
- Personality PRESETS (`chat_settings.mode`, admin `/mode <chatId> <пресет>`) are
  described ONCE in `src/modes.ts` — the registry (stored key + user-facing `name`
  surfer/calm/funny/dota/tutor/custom, label, description, greeting, and the four
  tone DEFAULTS `humor`/`slang`/`chime`/`reactions`) that the picker keyboard,
  `/modes`, `/mode`, `/chat`, the join-DM greeting and the setup card read from,
  so adding a preset is one entry plus a system prompt rather than a dozen
  `Record<ChatMode, …>` maps drifting apart. SETTINGS ARE PART OF THE PRESET:
  picking one (buttons, `/mode`, or `/prompt`) calls `applyModeDefaults`, which
  WRITES the preset's stances into the per-chat switches (`/humor`, `/slang`,
  `/chime`, `/react`) — from then on the switches alone decide, so an admin can
  keep the calm voice but flip the chime back on. `modeAllowsHumor/Slang/Chime/
  Reactions` are now STRUCTURAL (false only for the `toneLocked` tutor — a study
  room stays clean whatever the switches say, and never learns slang); every tone
  call site still checks `modeAllows* && isChat*Enabled`. Migration 029 backfilled
  the switches for chats configured under the old both-must-allow semantics.
  SETUP FLOW: after every pick the admin gets the behaviour card
  (`renderSetupCard` — what the humorizer/slang/chime/reactions actually DO, each
  knob's current state and its tap-to-copy toggle, plus the `/prompt` and `/rules`
  levers); `/setup <chatId>` reprints it any time. The "bot was added" DM
  (`onBotMembership.ts`) shows the picker with an «ℹ️ Что за режимы?» button
  (`m:?:<chatId>`) that renders the descriptions and keeps the picker on screen;
  `/modes` prints the same card, and `/mode <chatId>` with no mode replies with the
  buttons. Picking a preset still trusts the chat.
  `assistant` («спокойный», parse alias `calm`) is the calm one: the FULL secretary
  skill set with the persona removed — `ASSISTANT_SYSTEM_PROMPT` is a static
  persona-override suffix on `SYSTEM_PROMPT` (like dota, so behaviour rules are
  shared and the prefix stays cacheable) that bans jokes/surfer slang and points
  behaviour at the chat's RULES. It keeps memory + the learned slang (that's how it
  "adapts to the chat"); its defaults switch humor/chime/reactions off.
  `funny` («весельчак») is the jokester: full skill set, `FUNNY_SYSTEM_PROMPT`
  persona suffix (gags and puns, surfer theme banned) plus a matching
  `persona: 'funny'` humorizer variant; ships with everything on.
  `custom` («кастом») speaks whatever the admin described in their own words:
  `/prompt <chatId> <текст>` stores the description (`chat_settings.persona_prompt`,
  migration 029, capped at 2000 chars, `/prompt <id>` shows it, `clear` drops it)
  and switches the chat to the preset; `buildCustomSystemPrompt` frames the text as
  a TONE-ONLY override (it can't cancel accuracy/tool/safety rules — a test pins
  the framing), `systemPromptFor(mode, personaPrompt)` is the single prompt
  selector (live flow + scheduler), and `humorPersonaForMode` hands the same
  description to the tone pass (`HumorPersona` now includes `{custom: string}`).
  Without a description a custom chat runs as the calm assistant; its defaults are
  the neutral canvas (slang on, the rest off). `dota`
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
