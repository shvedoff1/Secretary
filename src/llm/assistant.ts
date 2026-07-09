import type Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { getAnthropic } from './client.js';
import { buildSystemPrompt, buildContextBlock } from './prompts.js';
import {
  buildTools,
  RECORD_EXPENSE_TOOL,
  REMEMBER_TOOL,
  EDIT_MEMORY_TOOL,
  LEARN_EXPENSE_TOOL,
  EDIT_LEXICON_TOOL,
  SCHEDULE_TASK_TOOL,
  SURF_FORECAST_TOOL,
  ADD_POI_TOOL,
  SPENDING_REPORT_TOOL,
} from './tools.js';
import {
  RecordExpenseZ,
  RememberZ,
  EditMemoryZ,
  LearnExpenseZ,
  EditLexiconZ,
  ScheduleTaskZ,
  SurfForecastZ,
  AddPoiZ,
  SpendingReportZ,
  toParsedExpense,
  type RecordExpenseInput,
  type RememberInput,
  type EditMemoryInput,
  type LearnExpenseInput,
  type EditLexiconInput,
  type ScheduleTaskInput,
  type SurfForecastInput,
  type AddPoiInput,
  type SpendingReportInput,
} from './schema.js';
import type { Turn } from '../db/repos/conversation.repo.js';
import type { ZodTypeAny } from 'zod';

export interface AssistantContext {
  defaultCurrency: string;
  members: { name: string; initials?: string }[];
  senderName: string;
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
  /** Expose the schedule_task tool (default true; false for scheduled runs). */
  allowReminders?: boolean;
  /** Expose the add_poi tool (default true; false for scheduled runs). */
  allowPoi?: boolean;
  /** Saved places in this chat, shown so the model can recall them and not duplicate. */
  places?: { name: string; category: string }[];
  /** Top shared facts about the group (human-like weighted memory). */
  memoryChat?: { content: string }[];
  /** Per-person facts: the current sender first, then other recently-active participants. */
  memoryUsers?: { subject: string; items: { content: string }[] }[];
  /** Voice/style directives for this chat (how to talk here), kept apart from facts. */
  memoryPersona?: { content: string }[];
  /** Selected persona preset's baseline voice text (empty for the neutral preset). */
  personaStyle?: string;
  history: Turn[];
  /** Plain text message, or image content blocks for a receipt photo. */
  userContent: string | Anthropic.ContentBlockParam[];
}

export interface AssistantHandlers {
  /** Persist a remembered note (optionally superseding contradicted facts); confirm. */
  remember: (input: RememberInput) => string;
  /** Fix an existing remembered fact in place; return a short confirmation. */
  editMemory: (input: EditMemoryInput) => string;
  /** Add trigger words to the chat's expense dictionary; return a confirmation. */
  learnExpense: (input: LearnExpenseInput) => string;
  /** Change the meaning of a learned slang word; return a short confirmation. */
  editLexicon: (input: EditLexiconInput) => string;
  /** Create a reminder / recurring task; return a short human confirmation. */
  scheduleTask: (input: ScheduleTaskInput) => string;
  /** Fetch a wave forecast for the given spots; return a compact data summary. */
  surfForecast: (input: SurfForecastInput) => Promise<string>;
  /** Save a point of interest; return a short human confirmation. */
  addPoi: (input: AddPoiInput) => string;
  /** Build a spending/balances report; return the ready-to-send (humorized) text. */
  spendingReport: (input: SpendingReportInput) => Promise<string>;
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
  | { kind: 'text'; text: string; scheduled?: boolean; humorizable?: boolean };

const MAX_ITERATIONS = 6;

/**
 * One dispatchable tool: how to validate its input, which handler to call, and the
 * fallback message when the model's arguments don't parse. `record_expense` and
 * `spending_report` are NOT here — they short-circuit the loop earlier (a preview /
 * verbatim report) instead of feeding a tool_result back to the model. `scheduled`
 * flags the reminder tool so the caller can keep that turn out of chat history.
 */
interface ToolRoute {
  schema: ZodTypeAny;
  fallback: string;
  scheduled?: boolean;
  handle: (input: unknown, handlers: AssistantHandlers) => string | Promise<string>;
}

const TOOL_ROUTES: Record<string, ToolRoute> = {
  [REMEMBER_TOOL]: {
    schema: RememberZ,
    fallback: 'Could not parse the note.',
    handle: (i, h) => h.remember(i as RememberInput),
  },
  [EDIT_MEMORY_TOOL]: {
    schema: EditMemoryZ,
    fallback: 'Could not parse the memory edit.',
    handle: (i, h) => h.editMemory(i as EditMemoryInput),
  },
  [LEARN_EXPENSE_TOOL]: {
    schema: LearnExpenseZ,
    fallback: 'Could not parse the expense keywords.',
    handle: (i, h) => h.learnExpense(i as LearnExpenseInput),
  },
  [EDIT_LEXICON_TOOL]: {
    schema: EditLexiconZ,
    fallback: 'Could not parse the slang edit.',
    handle: (i, h) => h.editLexicon(i as EditLexiconInput),
  },
  [SCHEDULE_TASK_TOOL]: {
    schema: ScheduleTaskZ,
    fallback: 'Could not parse the task.',
    scheduled: true,
    handle: (i, h) => h.scheduleTask(i as ScheduleTaskInput),
  },
  [SURF_FORECAST_TOOL]: {
    schema: SurfForecastZ,
    fallback: 'Could not parse the forecast request.',
    handle: (i, h) => h.surfForecast(i as SurfForecastInput),
  },
  [ADD_POI_TOOL]: {
    schema: AddPoiZ,
    fallback: 'Could not parse the place.',
    handle: (i, h) => h.addPoi(i as AddPoiInput),
  },
};

// The system prompt is assembled from the neutral core plus enabled skill fragments.
// Deployment config is static, so memoize per surf-flag value: the string must stay
// stable across calls for the prompt cache (cache_control below) to keep hitting.
const systemPromptCache = new Map<boolean, string>();
function cachedSystemPrompt(enableSurf: boolean): string {
  let prompt = systemPromptCache.get(enableSurf);
  if (prompt === undefined) {
    prompt = buildSystemPrompt({ enableSurf });
    systemPromptCache.set(enableSurf, prompt);
  }
  return prompt;
}

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
  const tools = buildTools({
    enableWebSearch: cfg.ENABLE_WEB_SEARCH,
    enableExpense: ctx.splidConnected,
    enableRemember: ctx.allowRemember !== false,
    enableMemoryEdit: ctx.allowRemember !== false,
    enableExpenseLearning: ctx.allowExpenseLearning !== false,
    enableLexiconEdit: ctx.allowLexiconEdit !== false,
    enableReminders: ctx.allowReminders !== false,
    enableSurf: cfg.ENABLE_SURF,
    enablePoi: ctx.allowPoi !== false,
    enableSpending: ctx.splidConnected,
  });

  const contextBlock = buildContextBlock({
    defaultCurrency: ctx.defaultCurrency,
    members: ctx.members,
    senderName: ctx.senderName,
    timezone: ctx.timezone,
    splidConnected: ctx.splidConnected,
    activeReminders: ctx.activeReminders ?? [],
    places: ctx.places ?? [],
    memoryChat: ctx.memoryChat ?? [],
    memoryUsers: ctx.memoryUsers ?? [],
    memoryPersona: ctx.memoryPersona ?? [],
    personaStyle: ctx.personaStyle,
  });

  const systemPrompt = cachedSystemPrompt(cfg.ENABLE_SURF);

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
      max_tokens: 2048,
      // Keep thinking OFF explicitly. On Sonnet 5 (the default model) adaptive
      // thinking turns ON whenever `thinking` is omitted — that would add latency
      // to every tool-routing turn AND eat into the 2048-token budget (thinking
      // counts against max_tokens), risking a truncated answer / tool-call JSON.
      // Disabling keeps the snappy, budget-safe behaviour we had on Sonnet 4.6;
      // it's a no-op on models where thinking was already off.
      thinking: { type: 'disabled' },
      // Cache the stable prefix (tools render before system, so one breakpoint on
      // the system block caches both tool schemas + system prompt). Re-reads cost
      // ~0.1x: this is the main lever against per-call token cost.
      system: [
        { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
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
      return { kind: 'text', text, humorizable: false };
    }

    if (res.stop_reason === 'tool_use') {
      usedTool = true;
      messages.push({ role: 'assistant', content: res.content });
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of res.content) {
        if (block.type !== 'tool_use') continue;
        const route = TOOL_ROUTES[block.name];
        if (!route) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: 'Not handled.',
            is_error: true,
          });
          continue;
        }
        // The reminder tool marks the turn scheduled even if its args don't parse,
        // matching the original behaviour (the caller keeps it out of history).
        if (route.scheduled) scheduled = true;
        const parsed = route.schema.safeParse(block.input);
        if (!parsed.success) {
          logger.warn({ err: parsed.error, tool: block.name }, 'tool input failed validation');
        }
        const confirmation = parsed.success
          ? await route.handle(parsed.data, handlers)
          : route.fallback;
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: confirmation,
          is_error: !parsed.success,
        });
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
    return { kind: 'text', text: text || '…', scheduled, humorizable: !usedTool };
  }

  return { kind: 'text', text: 'Что-то пошло не так, попробуй ещё раз.', scheduled };
}
