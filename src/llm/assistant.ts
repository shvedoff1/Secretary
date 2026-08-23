import type Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { getAnthropic } from './client.js';
import {
  SYSTEM_PROMPT,
  ASSISTANT_SYSTEM_PROMPT,
  TUTOR_SYSTEM_PROMPT,
  DOTA_SYSTEM_PROMPT,
  buildContextBlock,
  buildTutorContextBlock,
} from './prompts.js';
import type { ChatMode } from '../db/repos/chatSettings.repo.js';
import {
  buildTools,
  RECORD_EXPENSE_TOOL,
  REMEMBER_TOOL,
  EDIT_MEMORY_TOOL,
  RECALL_MEMORY_TOOL,
  LEARN_EXPENSE_TOOL,
  EDIT_LEXICON_TOOL,
  EDIT_PING_LIST_TOOL,
  SET_RULE_TOOL,
  SCHEDULE_TASK_TOOL,
  WATCH_PAGE_TOOL,
  DOTA_LOOKUP_TOOL,
  SURF_FORECAST_TOOL,
  ADD_POI_TOOL,
  SPENDING_REPORT_TOOL,
  SUMMARIZE_CHAT_TOOL,
} from './tools.js';
import {
  RecordExpenseZ,
  RememberZ,
  EditMemoryZ,
  RecallMemoryZ,
  LearnExpenseZ,
  EditLexiconZ,
  EditPingListZ,
  SetRuleZ,
  ScheduleTaskZ,
  WatchPageZ,
  DotaLookupZ,
  SurfForecastZ,
  AddPoiZ,
  SpendingReportZ,
  SummarizeChatZ,
  toParsedExpense,
  type RecordExpenseInput,
  type RememberInput,
  type EditMemoryInput,
  type RecallMemoryInput,
  type LearnExpenseInput,
  type EditLexiconInput,
  type EditPingListInput,
  type SetRuleInput,
  type ScheduleTaskInput,
  type WatchPageInput,
  type DotaLookupInput,
  type SurfForecastInput,
  type AddPoiInput,
  type SpendingReportInput,
  type SummarizeChatInput,
} from './schema.js';
import type { Turn } from '../db/repos/conversation.repo.js';

export interface AssistantContext {
  /**
   * Chat persona. 'secretary' (default) is the usual chill assistant with the full
   * toolset. 'tutor' is the accuracy-first exam-prep tutor: strict prompt, no
   * expense/surf/poi/slang tools (memory, reminders and web search stay), adaptive
   * thinking with a bigger token budget, and replies are never humorized. 'dota'
   * behaves exactly like secretary (full toolset, humorizable replies) but speaks
   * as the schoolkid-turned-Dota-teacher persona. 'assistant' is secretary with the
   * persona removed: same toolset, calm neutral voice, no jokes — how it behaves is
   * steered by the chat's own rules instead.
   */
  mode?: ChatMode;
  defaultCurrency: string;
  members: { name: string; initials?: string }[];
  senderName: string;
  /** Sender's Telegram @username (no @), for tools that need a handle. */
  senderUsername?: string | null;
  /** Chat IANA timezone, or null if not set yet. */
  timezone: string | null;
  /** Whether a Splid group is connected (gates the record_expense add-on). */
  splidConnected: boolean;
  /** Active reminders/tasks in this chat, shown so the model never recreates one. */
  activeReminders?: { id: number; title: string; when: string }[];
  /** Expose the remember tool (default true; false for scheduled runs). */
  allowRemember?: boolean;
  /** Expose the learn_expense_pattern tool (default true; false for scheduled runs). */
  allowExpenseLearning?: boolean;
  /** Expose the edit_lexicon tool (default true; false for scheduled runs). */
  allowLexiconEdit?: boolean;
  /** Expose the edit_ping_list tool (default true; false for scheduled runs). */
  allowPingEdit?: boolean;
  /** Expose the set_rule tool (default true; false for scheduled runs). */
  allowRules?: boolean;
  /** The chat's standing behaviour rules, injected as orders into the context block. */
  rules?: string[];
  /** Who runs the bot for this chat (display labels), for «кто ты?» answers. */
  botAdmins?: string[];
  /** Expose the schedule_task tool (default true; false for scheduled runs). */
  allowReminders?: boolean;
  /** Expose the watch_page tool (default true; false for scheduled runs). */
  allowWatch?: boolean;
  /** Active page watches in this chat, shown so the model never recreates one. */
  activeWatches?: { id: number; title: string; url: string }[];
  /** Expose the dota_lookup tool (dota-mode chats only; stays on for scheduled runs). */
  allowDota?: boolean;
  /** Expose the add_poi tool (default true; false for scheduled runs). */
  allowPoi?: boolean;
  /**
   * Expose the summarize_chat tool (recap the chat's raw message log). Read-only
   * like recall_memory, so it stays on for scheduled runs — a recurring «утром
   * перескажи вчерашнее» task needs exactly this. Off when chat logging is off.
   */
  allowSummary?: boolean;
  /** Saved places in this chat, shown so the model can recall them and not duplicate. */
  places?: { name: string; category: string }[];
  /** Top shared facts about the group (human-like weighted memory). */
  memoryChat?: { content: string }[];
  /** Per-person facts: the current sender first, then other recently-active participants. */
  memoryUsers?: { subject: string; items: { content: string }[] }[];
  /** Voice/style directives for this chat (how to talk here), kept apart from facts. */
  memoryPersona?: { content: string }[];
  /** Total facts stored for this chat, so the context can point at the deeper tier. */
  memoryTotal?: number;
  /**
   * EXPENSE-ONLY run: the silent auto-expense scan (a group message that was NOT
   * addressed to the bot but looks like a spend). Such a turn can only end in a
   * recorded expense or in silence — any text it produces is discarded by the
   * caller. So it is stripped down to exactly that job: `record_expense` is the ONLY
   * tool, and the context block carries no memory (nor reminders/watches/places).
   *
   * Memory is not just dead weight here, it MISFIRES: a remembered «я — Швед» led
   * the model to name the payer from memory instead of from the sender («Швед купил
   * круассан», with the sender being Андрей Шведов) and to reason about the identity
   * out loud. An unaddressed scan also must not WRITE anything — with the toolset cut
   * it can no longer quietly `remember`, `set_rule` or `schedule_task` on a message
   * nobody sent to the bot.
   */
  expenseOnly?: boolean;
  history: Turn[];
  /** Plain text message, or image content blocks for a receipt photo. */
  userContent: string | Anthropic.ContentBlockParam[];
}

export interface AssistantHandlers {
  /** Persist a remembered note (optionally superseding contradicted facts); confirm. */
  remember: (input: RememberInput) => string;
  /** Fix an existing remembered fact in place; return a short confirmation. */
  editMemory: (input: EditMemoryInput) => string;
  /** Search the full memory store; return the matching facts as text for the model. */
  recallMemory: (input: RecallMemoryInput) => string;
  /** Add trigger words to the chat's expense dictionary; return a confirmation. */
  learnExpense: (input: LearnExpenseInput) => string;
  /** Change the meaning of a learned slang word; return a short confirmation. */
  editLexicon: (input: EditLexiconInput) => string;
  /** Add/remove people on a /ping roll-call roster; return a short confirmation. */
  editPingList: (input: EditPingListInput) => string;
  /** Add/remove a standing behaviour rule for the chat; return a short confirmation. */
  setRule: (input: SetRuleInput) => string;
  /** Create a reminder / recurring task; return a short human confirmation. */
  scheduleTask: (input: ScheduleTaskInput) => string;
  /** Arm a page watch (poll a URL for an event); return a short confirmation. */
  watchPage: (input: WatchPageInput) => string;
  /** Read current-patch Dota data out of the local base; return ready text cards. */
  dotaLookup: (input: DotaLookupInput) => string;
  /** Fetch a wave forecast for the given spots; return a compact data summary. */
  surfForecast: (input: SurfForecastInput) => Promise<string>;
  /** Save a point of interest; return a short human confirmation. */
  addPoi: (input: AddPoiInput) => string;
  /** Build a spending/balances report; return the ready-to-send (humorized) text. */
  spendingReport: (input: SpendingReportInput) => Promise<string>;
  /**
   * Read back the chat's message log; return the transcript (or, for a big window,
   * cheap-model notes plus a verbatim tail) for the model to recap.
   */
  summarizeChat: (input: SummarizeChatInput) => Promise<string>;
}

export type AssistantResult =
  // One turn can yield SEVERAL expenses: a receipt that splits into groups
  // ("всё моё кроме доширака — он Ивану; палки на всех кроме Иры") is decomposed
  // into one expense per group, each previewed/confirmed on its own. `preamble`
  // is the model's short plain-text explanation of the breakdown, shown once
  // above the previews (null when it didn't explain — e.g. a single expense).
  | { kind: 'expense'; inputs: RecordExpenseInput[]; preamble: string | null }
  // `scheduled` marks a turn that created/handled a reminder, so the caller can
  // keep it out of conversation history (a lingering request would re-fire).
  // `humorizable` is true only for a plain-chat answer (no tool was used), so
  // the caller may run the optional tone-only humorizer over it without risking
  // factual answers (expenses, surf, web search, reminders).
  // `toned` marks text whose PRODUCER already ran a tone pass over it (the
  // spending digest humorizes/slangs itself, because the figures must ship
  // verbatim and it owns that call). The caller must not tone it a second time.
  | {
      kind: 'text';
      text: string;
      scheduled?: boolean;
      humorizable?: boolean;
      toned?: boolean;
    };

const MAX_ITERATIONS = 6;

/**
 * Turn stored conversation history into a valid Anthropic `messages` prefix.
 *
 * The API is strict: the first message must be `user`, and roles must strictly
 * alternate — two messages with the same role in a row is a hard error. Stored
 * history is NOT guaranteed to satisfy that: a sliding-window/age cut can drop a
 * user turn while keeping its assistant reply (leading assistant), and lone
 * assistant posts with no preceding user turn — a fired scheduled/recurring task
 * that the chat then replies to — can sit back-to-back (two assistants in a row).
 *
 * So we normalise instead of trusting the rows: skip any leading assistant turns,
 * and merge consecutive same-role turns into one message. Exported for testing.
 *
 * User turns are prefixed with their author's name ("Name: message") so the model
 * can tell speakers apart in a group — without it the history is a flat run of
 * "user" messages and the bot mixes people up (answers as if A said B's line).
 */
export function historyToMessages(history: Turn[]): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];
  for (const turn of history) {
    // The conversation must open on the user; drop assistant turns until one lands.
    if (messages.length === 0 && turn.role !== 'user') continue;
    const rendered =
      turn.role === 'user' && turn.senderName
        ? `${turn.senderName}: ${turn.content}`
        : turn.content;
    const last = messages[messages.length - 1];
    if (last && last.role === turn.role) {
      // Two same-role turns in a row (e.g. two scheduled posts, or two people
      // speaking before we replied) — fold into the first so alternation holds.
      // Each turn keeps its own "Name:" prefix so the authors stay distinct.
      last.content = `${last.content as string}\n${rendered}`;
    } else {
      messages.push({ role: turn.role, content: rendered });
    }
  }
  return messages;
}

export async function runAssistant(
  ctx: AssistantContext,
  handlers: AssistantHandlers,
): Promise<AssistantResult> {
  const cfg = loadConfig();
  const anthropic = getAnthropic();
  const tutor = ctx.mode === 'tutor';
  // An expense-only scan (an unaddressed message that merely looks like a spend) is
  // cut to the single tool it may use: it can only record an expense or stay silent,
  // and anything else it called would either be discarded or — for remember /
  // set_rule / schedule_task — silently write on a message nobody sent to the bot.
  // Guarded on splidConnected so the cut can never produce an empty tool list
  // (without a Splid group record_expense isn't exposed either — such a chat runs as usual).
  const expenseOnly = ctx.expenseOnly === true && ctx.splidConnected && !tutor;

  // Tutor mode keeps only what a study chat needs: memory (exam dates, weak
  // topics), reminders (study schedule) and web search. Everything money/surf/
  // slang-flavoured is off so the model can't wander back into secretary land.
  const tools = buildTools({
    enableWebSearch: !expenseOnly && cfg.ENABLE_WEB_SEARCH,
    enableExpense: !tutor && ctx.splidConnected,
    enableRemember: !expenseOnly && ctx.allowRemember !== false,
    enableMemoryEdit: !expenseOnly && ctx.allowRemember !== false,
    // Recall is READ-ONLY, so unlike remember/edit it stays on everywhere memory is:
    // scheduled runs and tutor chats need to look things up just as much. (An
    // expense-only scan is the one place it's off — that turn has no memory at all.)
    enableRecall: !expenseOnly && cfg.ENABLE_MEMORY,
    enableExpenseLearning: !expenseOnly && !tutor && ctx.allowExpenseLearning !== false,
    enableLexiconEdit: !expenseOnly && !tutor && ctx.allowLexiconEdit !== false,
    enablePingEdit: !expenseOnly && !tutor && ctx.allowPingEdit !== false,
    // Rules steer behaviour in EVERY mode (a study chat sets them too), and are
    // off only for scheduled runs — a firing task must not rewrite the chat's rules.
    enableRules: !expenseOnly && ctx.allowRules !== false,
    enableReminders: !expenseOnly && ctx.allowReminders !== false,
    enableWatch: !expenseOnly && !tutor && cfg.ENABLE_WATCH && ctx.allowWatch !== false,
    // Dota reference data is only ever relevant in a dota chat, and keeping it
    // out of the default tool list leaves every other chat's cached prefix alone.
    enableDota:
      !expenseOnly && ctx.mode === 'dota' && cfg.ENABLE_DOTA && ctx.allowDota !== false,
    enableSurf: !expenseOnly && !tutor && cfg.ENABLE_SURF,
    enablePoi: !expenseOnly && !tutor && ctx.allowPoi !== false,
    enableSpending: !expenseOnly && !tutor && ctx.splidConnected,
    // Recapping the log is read-only, so (like recall_memory) it survives scheduled
    // runs; a tutor room has no chatter to recap, and without the log there is
    // nothing to read.
    enableSummary:
      !expenseOnly && !tutor && cfg.ENABLE_CHAT_LOG && ctx.allowSummary !== false,
  });

  const contextBlock = tutor
    ? buildTutorContextBlock({
        senderName: ctx.senderName,
        timezone: ctx.timezone,
        activeReminders: ctx.activeReminders ?? [],
        memoryChat: ctx.memoryChat ?? [],
        memoryUsers: ctx.memoryUsers ?? [],
        memoryTotal: ctx.memoryTotal ?? 0,
        rules: ctx.rules ?? [],
      })
    : buildContextBlock({
        defaultCurrency: ctx.defaultCurrency,
        members: ctx.members,
        senderName: ctx.senderName,
        senderUsername: ctx.senderUsername ?? null,
        timezone: ctx.timezone,
        splidConnected: ctx.splidConnected,
        activeReminders: ctx.activeReminders ?? [],
        activeWatches: ctx.activeWatches ?? [],
        places: ctx.places ?? [],
        memoryChat: expenseOnly ? [] : (ctx.memoryChat ?? []),
        memoryUsers: expenseOnly ? [] : (ctx.memoryUsers ?? []),
        memoryPersona: expenseOnly ? [] : (ctx.memoryPersona ?? []),
        // Total held, so the block can tell the model how much memory it does NOT
        // see and that recall_memory reaches the rest (the hint is skipped when
        // nothing is hidden, and on an expense-only scan there is no memory at all).
        memoryTotal: expenseOnly ? 0 : (ctx.memoryTotal ?? 0),
        rules: ctx.rules ?? [],
        botAdmins: ctx.botAdmins ?? [],
        expenseOnly,
      });

  let scheduled = false;
  // Tracks whether any tool ran this turn. A plain-chat answer (no tools) is the
  // only thing safe to hand to the tone-only humorizer downstream.
  let usedTool = false;

  // Normalise stored history into a valid alternating prefix (first turn user, no
  // two same-role turns in a row) before appending the current user message —
  // otherwise a window cut or a lone scheduled-task post would make the API reject
  // the whole request. The current turn below is always `user`, and normalised
  // history always ends on `assistant` (or is empty), so the append stays alternating.
  const messages: Anthropic.MessageParam[] = historyToMessages(ctx.history);

  // Label the current message with its sender the same way history turns are
  // labelled ("Name: message"), so the model attributes it to the right person and
  // never confuses the current speaker with someone named in the conversation.
  const currentContent: Anthropic.ContentBlockParam[] = [
    { type: 'text', text: contextBlock },
  ];
  if (typeof ctx.userContent === 'string') {
    currentContent.push({ type: 'text', text: `${ctx.senderName}: ${ctx.userContent}` });
  } else {
    currentContent.push({ type: 'text', text: `${ctx.senderName}:` });
    currentContent.push(...ctx.userContent);
  }
  messages.push({ role: 'user', content: currentContent });

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const res = await anthropic.messages.create({
      model: cfg.ANTHROPIC_MODEL,
      // Tutor answers are long (step-by-step solutions) and adaptive thinking
      // spends from the same budget, so tutor mode gets a much bigger cap.
      max_tokens: tutor ? 8192 : 2048,
      // Secretary keeps thinking OFF explicitly. On Sonnet 5 (the default model)
      // adaptive thinking turns ON whenever `thinking` is omitted — that would add
      // latency to every tool-routing turn AND eat into the 2048-token budget
      // (thinking counts against max_tokens), risking a truncated answer /
      // tool-call JSON. Disabling keeps the snappy behaviour we had on Sonnet 4.6.
      // Tutor mode is the opposite trade: accuracy over latency — solving
      // math/physics is exactly what thinking is for, so let the model reason.
      thinking: { type: tutor ? 'adaptive' : 'disabled' },
      // Cache the stable prefix (tools render before system, so one breakpoint on
      // the system block caches both tool schemas + system prompt). Re-reads cost
      // ~0.1x: this is the main lever against per-call token cost. Tutor chats
      // form their own (also static) cache prefix.
      system: [
        {
          type: 'text',
          // Dota mode is secretary-with-a-different-persona: same context block,
          // same tools, same thinking/token budget — only the system prompt (and
          // hence its own cache prefix) differs.
          text: tutor
            ? TUTOR_SYSTEM_PROMPT
            : ctx.mode === 'dota'
              ? DOTA_SYSTEM_PROMPT
              : ctx.mode === 'assistant'
                ? ASSISTANT_SYSTEM_PROMPT
                : SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      tools,
      messages,
    });

    logger.debug(
      {
        model: cfg.ANTHROPIC_MODEL,
        input: res.usage.input_tokens,
        output: res.usage.output_tokens,
        cacheRead: res.usage.cache_read_input_tokens,
        cacheWrite: res.usage.cache_creation_input_tokens,
      },
      'assistant usage',
    );

    // record_expense short-circuits: it's a side-effecting action gated by a
    // human confirmation, so we stop and let the bot render a preview. The model
    // may emit SEVERAL record_expense calls in one turn (a receipt split into
    // per-group expenses) — collect them all, plus any text block it wrote
    // alongside to explain the breakdown.
    const recordBlocks = res.content.filter(
      (b): b is Anthropic.ToolUseBlock =>
        b.type === 'tool_use' && b.name === RECORD_EXPENSE_TOOL,
    );
    if (recordBlocks.length > 0) {
      const inputs: RecordExpenseInput[] = [];
      for (const block of recordBlocks) {
        const parsed = RecordExpenseZ.safeParse(block.input);
        if (parsed.success) inputs.push(parsed.data);
        else logger.warn({ err: parsed.error }, 'record_expense input failed validation');
      }
      if (inputs.length === 0) {
        return {
          kind: 'text',
          text: 'Не смог разобрать трату — попробуй сформулировать иначе (сумма, на кого делим).',
        };
      }
      const preamble = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
      return { kind: 'expense', inputs, preamble: preamble || null };
    }

    // spending_report short-circuits too: the handler returns ready, exact,
    // already-humorized text (figures must reach the user verbatim, so we don't
    // feed it back for the model to re-phrase). humorizable=false keeps the
    // downstream humorizer off — the handler already ran it.
    const spendingBlock = res.content.find(
      (b): b is Anthropic.ToolUseBlock =>
        b.type === 'tool_use' && b.name === SPENDING_REPORT_TOOL,
    );
    if (spendingBlock) {
      const parsed = SpendingReportZ.safeParse(spendingBlock.input);
      if (!parsed.success) {
        logger.warn({ err: parsed.error }, 'spending_report input failed validation');
        return {
          kind: 'text',
          text: 'Не понял период для отчёта — уточни, за какие дни.',
        };
      }
      const text = await handlers.spendingReport(parsed.data);
      return { kind: 'text', text, humorizable: false, toned: true };
    }

    if (res.stop_reason === 'tool_use') {
      usedTool = true;
      messages.push({ role: 'assistant', content: res.content });
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of res.content) {
        if (block.type !== 'tool_use') continue;
        if (block.name === REMEMBER_TOOL) {
          const parsed = RememberZ.safeParse(block.input);
          const confirmation = parsed.success
            ? handlers.remember(parsed.data)
            : 'Could not parse the note.';
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: confirmation,
            is_error: !parsed.success,
          });
        } else if (block.name === RECALL_MEMORY_TOOL) {
          const parsed = RecallMemoryZ.safeParse(block.input);
          if (!parsed.success) {
            logger.warn({ err: parsed.error }, 'recall_memory input failed validation');
          }
          const found = parsed.success
            ? handlers.recallMemory(parsed.data)
            : 'Could not parse the memory query.';
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: found,
            is_error: !parsed.success,
          });
        } else if (block.name === EDIT_MEMORY_TOOL) {
          const parsed = EditMemoryZ.safeParse(block.input);
          if (!parsed.success) {
            logger.warn({ err: parsed.error }, 'edit_memory input failed validation');
          }
          const confirmation = parsed.success
            ? handlers.editMemory(parsed.data)
            : 'Could not parse the memory edit.';
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: confirmation,
            is_error: !parsed.success,
          });
        } else if (block.name === LEARN_EXPENSE_TOOL) {
          const parsed = LearnExpenseZ.safeParse(block.input);
          if (!parsed.success) {
            logger.warn({ err: parsed.error }, 'learn_expense_pattern input failed validation');
          }
          const confirmation = parsed.success
            ? handlers.learnExpense(parsed.data)
            : 'Could not parse the expense keywords.';
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: confirmation,
            is_error: !parsed.success,
          });
        } else if (block.name === EDIT_LEXICON_TOOL) {
          const parsed = EditLexiconZ.safeParse(block.input);
          if (!parsed.success) {
            logger.warn({ err: parsed.error }, 'edit_lexicon input failed validation');
          }
          const confirmation = parsed.success
            ? handlers.editLexicon(parsed.data)
            : 'Could not parse the slang edit.';
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: confirmation,
            is_error: !parsed.success,
          });
        } else if (block.name === SET_RULE_TOOL) {
          const parsed = SetRuleZ.safeParse(block.input);
          if (!parsed.success) {
            logger.warn({ err: parsed.error }, 'set_rule input failed validation');
          }
          const confirmation = parsed.success
            ? handlers.setRule(parsed.data)
            : 'Could not parse the rule.';
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: confirmation,
            is_error: !parsed.success,
          });
        } else if (block.name === EDIT_PING_LIST_TOOL) {
          const parsed = EditPingListZ.safeParse(block.input);
          if (!parsed.success) {
            logger.warn({ err: parsed.error }, 'edit_ping_list input failed validation');
          }
          const confirmation = parsed.success
            ? handlers.editPingList(parsed.data)
            : 'Could not parse the ping-list edit.';
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: confirmation,
            is_error: !parsed.success,
          });
        } else if (block.name === SCHEDULE_TASK_TOOL) {
          scheduled = true;
          const parsed = ScheduleTaskZ.safeParse(block.input);
          if (!parsed.success) {
            logger.warn({ err: parsed.error }, 'schedule_task input failed validation');
          }
          const confirmation = parsed.success
            ? handlers.scheduleTask(parsed.data)
            : 'Could not parse the task.';
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: confirmation,
            is_error: !parsed.success,
          });
        } else if (block.name === WATCH_PAGE_TOOL) {
          const parsed = WatchPageZ.safeParse(block.input);
          if (!parsed.success) {
            logger.warn({ err: parsed.error }, 'watch_page input failed validation');
          }
          const confirmation = parsed.success
            ? handlers.watchPage(parsed.data)
            : 'Could not parse the page watch.';
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: confirmation,
            is_error: !parsed.success,
          });
        } else if (block.name === DOTA_LOOKUP_TOOL) {
          const parsed = DotaLookupZ.safeParse(block.input);
          if (!parsed.success) {
            logger.warn({ err: parsed.error }, 'dota_lookup input failed validation');
          }
          const confirmation = parsed.success
            ? handlers.dotaLookup(parsed.data)
            : 'Could not parse the dota lookup.';
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: confirmation,
            is_error: !parsed.success,
          });
        } else if (block.name === SURF_FORECAST_TOOL) {
          const parsed = SurfForecastZ.safeParse(block.input);
          if (!parsed.success) {
            logger.warn({ err: parsed.error }, 'surf_forecast input failed validation');
          }
          const confirmation = parsed.success
            ? await handlers.surfForecast(parsed.data)
            : 'Could not parse the forecast request.';
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: confirmation,
            is_error: !parsed.success,
          });
        } else if (block.name === SUMMARIZE_CHAT_TOOL) {
          const parsed = SummarizeChatZ.safeParse(block.input);
          if (!parsed.success) {
            logger.warn({ err: parsed.error }, 'summarize_chat input failed validation');
          }
          // Deliberately NOT a short-circuit like spending_report: the transcript
          // goes back to the model, which writes the recap in the chat's voice and
          // can then answer follow-ups about it from the same window.
          const transcript = parsed.success
            ? await handlers.summarizeChat(parsed.data)
            : 'Could not parse the summary request.';
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: transcript,
            is_error: !parsed.success,
          });
        } else if (block.name === ADD_POI_TOOL) {
          const parsed = AddPoiZ.safeParse(block.input);
          if (!parsed.success) {
            logger.warn({ err: parsed.error }, 'add_poi input failed validation');
          }
          const confirmation = parsed.success
            ? handlers.addPoi(parsed.data)
            : 'Could not parse the place.';
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: confirmation,
            is_error: !parsed.success,
          });
        } else {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: 'Not handled.',
            is_error: true,
          });
        }
      }
      if (toolResults.length === 0) break;
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    if (res.stop_reason === 'pause_turn') {
      // Server-side tool (web_search) hit the loop limit — resume. This is a
      // tool answer, so it must not be humorized.
      usedTool = true;
      messages.push({ role: 'assistant', content: res.content });
      continue;
    }

    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    // Tutor answers are never humorizable: precision is the whole point of the
    // mode, so the OpenAI tone pass must not touch them (this also covers the
    // scheduler path, which trusts this flag).
    return { kind: 'text', text: text || '…', scheduled, humorizable: !usedTool && !tutor };
  }

  return { kind: 'text', text: 'Что-то пошло не так, попробуй ещё раз.', scheduled };
}
