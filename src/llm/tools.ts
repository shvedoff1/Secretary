import type Anthropic from '@anthropic-ai/sdk';
import {
  recordExpenseJsonSchema,
  rememberJsonSchema,
  editMemoryJsonSchema,
  recallMemoryJsonSchema,
  learnExpenseJsonSchema,
  editLexiconJsonSchema,
  editPingListJsonSchema,
  setRuleJsonSchema,
  scheduleTaskJsonSchema,
  watchPageJsonSchema,
  dotaLookupJsonSchema,
  surfForecastJsonSchema,
  addPoiJsonSchema,
  spendingReportJsonSchema,
  summarizeChatJsonSchema,
} from './schema.js';

export const RECORD_EXPENSE_TOOL = 'record_expense';
export const REMEMBER_TOOL = 'remember';
export const EDIT_MEMORY_TOOL = 'edit_memory';
export const RECALL_MEMORY_TOOL = 'recall_memory';
export const LEARN_EXPENSE_TOOL = 'learn_expense_pattern';
export const EDIT_LEXICON_TOOL = 'edit_lexicon';
export const EDIT_PING_LIST_TOOL = 'edit_ping_list';
export const SET_RULE_TOOL = 'set_rule';
export const SCHEDULE_TASK_TOOL = 'schedule_task';
export const WATCH_PAGE_TOOL = 'watch_page';
export const DOTA_LOOKUP_TOOL = 'dota_lookup';
export const SURF_FORECAST_TOOL = 'surf_forecast';
export const ADD_POI_TOOL = 'add_poi';
export const SPENDING_REPORT_TOOL = 'spending_report';
export const SUMMARIZE_CHAT_TOOL = 'summarize_chat';

export interface ToolOptions {
  enableWebSearch: boolean;
  /** Expose record_expense only where a Splid group is connected (it's an add-on). */
  enableExpense: boolean;
  /** Expose the remember tool. Default true; disabled for scheduled runs. */
  enableRemember?: boolean;
  /** Expose the edit_memory tool (fix an existing remembered fact in place). Default
   *  true; disabled for scheduled runs (a firing task shouldn't rewrite memory). */
  enableMemoryEdit?: boolean;
  /** Expose the recall_memory tool (search the FULL memory store, beyond the small
   *  working set injected into every turn). Default true — it is read-only, so it
   *  stays on for scheduled runs and tutor chats too; off when ENABLE_MEMORY is off. */
  enableRecall?: boolean;
  /** Expose the learn_expense_pattern tool. Default true; disabled for scheduled runs. */
  enableExpenseLearning?: boolean;
  /** Expose the edit_lexicon tool (correct a slang word's meaning). Default true;
   *  disabled for scheduled runs (a firing task shouldn't rewrite the lexicon). */
  enableLexiconEdit?: boolean;
  /** Expose the edit_ping_list tool (edit the /ping roll-call rosters in plain
   *  words). Default true; disabled for scheduled runs and tutor chats. */
  enablePingEdit?: boolean;
  /** Expose the set_rule tool (standing behaviour rules for the chat, set in plain
   *  words). Default true; disabled for scheduled runs — a firing task must not
   *  rewrite how the bot behaves. Available in every mode, tutor included. */
  enableRules?: boolean;
  /** Expose the schedule_task tool. Default true; disabled for scheduled runs so a
   *  firing reminder can't create more reminders. */
  enableReminders?: boolean;
  /** Expose the watch_page tool (poll a URL until an awaited event appears).
   *  Default true; disabled for scheduled runs (a firing task must not spawn
   *  watches), tutor chats, and when ENABLE_WATCH is off. */
  enableWatch?: boolean;
  /** Expose the dota_lookup tool (current-patch hero/item/ability reference read
   *  from the locally synced knowledge base). Only in dota-mode chats, and only
   *  when ENABLE_DOTA is on. Stays on for scheduled runs so a recurring "разбор
   *  патча по утрам" task can use it. */
  enableDota?: boolean;
  /** Expose the surf_forecast tool. Default true; stays on for scheduled runs so a
   *  recurring evening task can produce the "where to go tomorrow" report. */
  enableSurf?: boolean;
  /** Expose the add_poi tool. Default true; disabled for scheduled runs. */
  enablePoi?: boolean;
  /** Expose the spending_report tool. Only where a Splid group is connected (it
   *  reads expenses/balances back from the group). Stays on for scheduled runs so
   *  a recurring "сводка трат в 9 утра" task can produce the digest. */
  enableSpending?: boolean;
  /** Expose the summarize_chat tool (recap the chat's raw message log). Read-only,
   *  so like recall_memory it stays on for scheduled runs — a recurring "утренний
   *  пересказ вчерашнего" task needs it. Off when ENABLE_CHAT_LOG is off (nothing
   *  is recorded) and in tutor chats. */
  enableSummary?: boolean;
}

export function buildTools(opts: ToolOptions): Anthropic.ToolUnion[] {
  const tools: Anthropic.ToolUnion[] = [];

  // Splid expense recording is an optional add-on: only offer the tool when the
  // chat actually has a group connected, so general chats (DMs, un-linked groups)
  // can never misroute a reminder/question into the expense flow.
  if (opts.enableExpense) {
    tools.push({
      name: RECORD_EXPENSE_TOOL,
      description:
        'Propose a shared expense to be recorded in Splid (after user confirmation). Call this only when a message or receipt describes a shared purchase to split.',
      input_schema: recordExpenseJsonSchema as unknown as Anthropic.Tool.InputSchema,
    });
  }

  if (opts.enableRemember !== false) {
    tools.push({
      name: REMEMBER_TOOL,
      description:
        'Save a durable note to long-term memory. ONLY call this when the user EXPLICITLY asks to remember/save something (e.g. "запомни…", "сохрани…", "remember that…"). Never auto-remember expenses, receipts, or casual chatter. If the note corrects/contradicts a fact already in the context memory, pass those facts verbatim in `replaces` so the new note overrides them instead of coexisting.',
      input_schema: rememberJsonSchema as unknown as Anthropic.Tool.InputSchema,
    });
  }

  if (opts.enableMemoryEdit !== false) {
    tools.push({
      name: EDIT_MEMORY_TOOL,
      description:
        "Fix an EXISTING remembered fact in place — the «поправь/исправь в памяти …», «запись неверная, поменяй …» flow. Call this when the user wants to correct a fact the bot already stored (a typo, a wrong detail) WITHOUT adding a new one. Pass `find` = the current fact copied verbatim from the context memory sections, `replace` = the corrected full text. To ADD a new fact use remember; to change what a slang word MEANS use edit_lexicon.",
      input_schema: editMemoryJsonSchema as unknown as Anthropic.Tool.InputSchema,
    });
  }

  if (opts.enableRecall !== false) {
    tools.push({
      name: RECALL_MEMORY_TOOL,
      description:
        "Search the chat's FULL long-term memory: remembered FACTS plus the conversation journal (condensed notes of past chat sessions). The context block shows only the handful of facts and newest journal entries that are salient right now; everything else stays in the store and is reachable ONLY through this tool. Call it BEFORE answering whenever the answer depends on something specific the chat told you earlier and you cannot see it above — a person's preferences, allergies, birthdays, plans, past decisions, «а помнишь…», «что я тебе говорил про…», «что ты знаешь про <человек>», «о чём мы говорили про <тему>». Cheap and read-only: a miss costs nothing, while answering «не помню» when the fact is stored is the failure worth avoiding. Journal hits are notes, not verbatim — the result names the dates to hand summarize_chat when the exact wording is needed. Do NOT call it for facts already visible in the context, for general knowledge (that's web_search) or for expenses (that's spending_report).",
      input_schema: recallMemoryJsonSchema as unknown as Anthropic.Tool.InputSchema,
    });
  }

  if (opts.enableExpenseLearning !== false) {
    tools.push({
      name: LEARN_EXPENSE_TOOL,
      description:
        "Teach THIS chat's expense-detection dictionary a new trigger word/phrase, so future messages containing it (with a number) are auto-treated as likely expenses — no redeploy needed. Call this ONLY when the user EXPLICITLY teaches you that a kind of message is an expense, typically by replying to a message the bot missed and saying «запомни, такие сообщения — это траты», «это тоже трата», «такое тоже записывай как трату». Extract the distinctive keyword(s) from the referenced message (shown to you as [В ответ на сообщение: …]). Do NOT call this for a one-off expense to record (use record_expense) or for general notes (use remember).",
      input_schema: learnExpenseJsonSchema as unknown as Anthropic.Tool.InputSchema,
    });
  }

  if (opts.enableLexiconEdit !== false) {
    tools.push({
      name: EDIT_LEXICON_TOOL,
      description:
        "Change the stored MEANING of a word in THIS chat's learned slang. Call this ONLY when the user explicitly asks to fix/change what a slang word means — e.g. «поменяй значение у пихалыч на рот», «у братик поставь значение …», «слово X значит Y, исправь». Pass `term` = the slang word (as used in the chat) and `gloss` = the new short meaning. This edits an EXISTING learned word's meaning; it does not add brand-new words (use nothing for that — the bot learns words on its own) and is not for general notes (use remember) or expense keywords (use learn_expense_pattern).",
      input_schema: editLexiconJsonSchema as unknown as Anthropic.Tool.InputSchema,
    });
  }

  if (opts.enablePingEdit !== false) {
    tools.push({
      name: EDIT_PING_LIST_TOOL,
      description:
        "Edit THIS chat's ping rosters — the named lists the /ping roll-call command pings — and personal quiet hours. Call this when the user asks IN PLAIN WORDS to add or remove people («добавь @vasya в основной пинг», «убери @petya и @kolya из пинга») OR to set do-not-ping windows for themselves/someone («не тегай меня до 19:00 по будням», «в воскресенье с 18 до 21 меня не пинговать» => action mute with those windows; «снимай мой мут», «можно снова тегать» => unmute). For mute, set `replace` from the phrasing: an ADDITION to an existing schedule («ещё…», «а также…») => replace false (append); a full restatement/correction («только до 18», «теперь так», the first rule) => replace true. A combined ask («добавь меня в пинг, но не тегай до 19») = TWO calls in one turn: add, then mute. «Исправь меншн X на Y» / «у него ник другой» => action rename (members=[old], renameTo=new) — applies across all lists, quiet hours survive; never model it as remove+add. Copy members AS WRITTEN (keep the @); «меня» = the sender's @username from the context block (ask once if it's not there). NEVER invent a handle: a username is latin-only, so a Cyrillic «@Имя» is a fabrication that pings nobody — if the real ник is unknown, ask and suggest the person reply in the chat so it becomes visible. Times default to Europe/Moscow unless another zone is named. `list` = the named list or null for the default; quiet hours apply per person chat-wide. This only edits data: the actual ping is the user's /ping command, and /ping show displays rosters + quiet hours without pinging. IMPORTANT: in your confirmation reply do NOT repeat the @usernames (that would ping them) — refer to them without the @ or by count.",
      input_schema: editPingListJsonSchema as unknown as Anthropic.Tool.InputSchema,
    });
  }

  if (opts.enableRules !== false) {
    tools.push({
      name: SET_RULE_TOOL,
      description:
        "Set or drop a STANDING behaviour rule for THIS chat — how you must work here from now on, said by the user in plain words: «с этого момента все голосовые очищай от слов-паразитов и скидывай расшифровку», «отвечай короче», «не используй эмодзи», «всегда пиши по-английски». Call it with action 'add' the moment the user states such a standing instruction, then follow the rule starting with this very reply; call it with action 'remove' when they cancel one («забудь правило про голосовые»), passing the rule as it appears under \"Chat rules\" in the context block. Rules already listed there are IN FORCE — never re-add one. NOT for facts to know (that's remember), NOT for a one-off ask about the current reply (just do it), NOT for anything time-based (that's schedule_task).",
      input_schema: setRuleJsonSchema as unknown as Anthropic.Tool.InputSchema,
    });
  }

  if (opts.enableReminders !== false) {
    tools.push({
      name: SCHEDULE_TASK_TOOL,
      description:
        'Create a TIME-BASED reminder or recurring task. Call this ONLY for a NEW request in the user\'s latest message (e.g. "напомни встать через 3 минуты", "каждое утро ищи прогноз волн и кидай сюда"). Convert the timing into a cron expression. The task `prompt` runs later WITHOUT chat history, so make it self-contained. Set `humor` to true when the user wants a funny/light tone for this task and false for a plain reminder. Never recreate a reminder that already appears in "Active reminders" in the context. Confirm timezone with the user once if it is unknown in the context. NOT for watching a web page until something appears on it («следи за <ссылка> и напиши, когда появятся сеансы/билеты/в наличии») — that is `watch_page` (its poller checks the page every few minutes, a cron task would check daily and miss the event); never model a page watch as a scheduled task.',
      input_schema: scheduleTaskJsonSchema as unknown as Anthropic.Tool.InputSchema,
    });
  }

  if (opts.enableWatch !== false) {
    tools.push({
      name: WATCH_PAGE_TOOL,
      description:
        'Start watching a WEB PAGE and notify this chat when an awaited event appears on it. Call this when the user gives a URL and asks to be told when something appears/changes there («следи за этой страницей и напиши, когда появятся сеансы фильма X», «мониторь, когда билеты поступят в продажу», «скажи, когда появится в наличии»). The bot polls the page itself and posts a notification when the event shows up — do NOT also create a schedule_task for the same thing. `condition` must describe the awaited event precisely (including what does NOT count — e.g. a «скоро в кино» teaser); `keywords` are lowercase substrings identifying the TARGET (title in the page\'s language + variants/translit) that gate the check. Never re-create a watch already listed in "Active page watches" in the context; the list is managed with /watch. Event-on-a-page waiting only — time-based reminders stay schedule_task.',
      input_schema: watchPageJsonSchema as unknown as Anthropic.Tool.InputSchema,
    });
  }

  if (opts.enableDota) {
    tools.push({
      name: DOTA_LOOKUP_TOOL,
      description:
        'Look up CURRENT Dota 2 data — heroes, items, abilities, talents and what the latest patch changed — in the bot\'s local base, which is re-synced from Valve\'s own datafeed every night. Call this EVERY time the answer depends on concrete game data: what an item does or costs, an ability\'s cooldown/damage/duration, a hero\'s stats or talents, what changed in the patch («что делает Crella\'s Crozier», «сколько кулдаун у блинка», «какие таланты у Джаггернаута», «что поменяли у Акса»). Your own knowledge of Dota is STALE — items get reworked and renumbered every patch, so answering from memory is how you get the numbers wrong. Pass `names` as canonical ENGLISH names the way Valve spells them (translate the chat\'s «ам»/«бкб»/«анти-маг» yourself), or use `query` for a freetext search when no specific entity is named. The tool returns exact figures for the current patch — relay them as-is, in your usual tone; do not recompute or "correct" them. If it reports that something is missing, say so instead of filling the gap from memory.',
      input_schema: dotaLookupJsonSchema as unknown as Anthropic.Tool.InputSchema,
    });
  }

  if (opts.enableSurf !== false) {
    tools.push({
      name: SURF_FORECAST_TOOL,
      description:
        'Get a wave, wind and tide forecast for several spots and recommend where (and when) to go. Call this when the user asks about waves, surf, or where to go surfing ("какие волны завтра", "куда ехать на сёрф", "where will it be good"). You pick several popular spots near the region they mean (from your own knowledge) with coordinates of a point in the water, plus the day (today/tomorrow) and the chat timezone. It returns per-spot wave/wind plus the day\'s high/low tide times — match each spot\'s ideal tide to recommend the best spot(s) and time(s).',
      input_schema: surfForecastJsonSchema as unknown as Anthropic.Tool.InputSchema,
    });
  }

  if (opts.enablePoi !== false) {
    tools.push({
      name: ADD_POI_TOOL,
      description:
        'Save a point of interest to this chat\'s list of places — a cafe/restaurant worth remembering, a sight they visited, or a place they plan to go. Call this when the user wants to keep a place ("запиши это кафе", "добавь в места", "хочу сходить сюда", "сохрани это место"). Pick the best category and copy any address or coordinates mentioned so a Google Maps link can be built. View the list with /poi.',
      input_schema: addPoiJsonSchema as unknown as Anthropic.Tool.InputSchema,
    });
  }

  if (opts.enableSpending) {
    tools.push({
      name: SPENDING_REPORT_TOOL,
      description:
        "Summarise recorded spending and/or who-owes-whom for the chat's Splid group. Call this when the user asks about PAST spending (\"сколько потратили за неделю\", \"траты за вчера\", \"скинь траты за последние 3 дня\", \"how much did we spend\") or about balances/debts (\"сколько кто кому должен\", \"who owes what\", \"мы в расчёте?\"). For the spending summary, pass fromDate/toDate as chat-LOCAL YYYY-MM-DD computed from the context block's current time + timezone (single day => equal dates; null/null => yesterday). Set balances=true for the settlement summary. It returns ready-formatted figures — relay them as-is, don't recompute. This READS the data; it does not record anything (use record_expense for that).",
      input_schema: spendingReportJsonSchema as unknown as Anthropic.Tool.InputSchema,
    });
  }

  if (opts.enableSummary) {
    tools.push({
      name: SUMMARIZE_CHAT_TOOL,
      description:
        "Read back what was actually SAID in this chat — the raw message log, including every message you never replied to — and recap it. Call this whenever the user asks what happened/was discussed here: «что было в последних 200 сообщениях», «перескажи, что я пропустил», «о чём тут болтали вчера», «краткая выжимка за сегодня», «what did I miss». It is ALSO the tool for a request to rebuild the CONTEXT rather than a period: «восстанови картину/картинку по истории чата», «подними контекст», «вспомни, о чём тут шла речь», «введи меня в курс» — «картина»/«картинка» there means the picture of EVENTS, never an image file, so read the log instead of replying that you don't keep photos. Ask by COUNT (limit) when the user names a number of messages, or by chat-LOCAL DATES (fromDate/toDate) when they name a period; for a bare «подними контекст» leave everything null and take the recent default. The tool returns the transcript itself — YOU write the summary from it, in the user's language and your usual voice, and you never invent anything that isn't there. This is NOT memory (recall_memory searches remembered FACTS; this reads the literal chat log) and NOT money (that's spending_report). The log is bounded in size and age, so it may not reach as far back as asked — the tool says so, and you must pass that on rather than filling the gap.",
      input_schema: summarizeChatJsonSchema as unknown as Anthropic.Tool.InputSchema,
    });
  }

  if (opts.enableWebSearch) {
    // _20260209 adds dynamic result filtering — Claude filters results before they
    // hit the context window, cutting tokens on search-heavy turns. Supported on
    // Sonnet 4.6 (current default) and the Opus 4.6+ family.
    tools.push({ type: 'web_search_20260209', name: 'web_search', max_uses: 5 });
  }

  return tools;
}
