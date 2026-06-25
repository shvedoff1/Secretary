import type Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { getAnthropic } from './client.js';
import { SYSTEM_PROMPT, buildContextBlock } from './prompts.js';
import {
  buildTools,
  RECORD_EXPENSE_TOOL,
  REMEMBER_TOOL,
  LEARN_EXPENSE_TOOL,
  SCHEDULE_TASK_TOOL,
  SURF_FORECAST_TOOL,
  ADD_POI_TOOL,
} from './tools.js';
import {
  RecordExpenseZ,
  RememberZ,
  LearnExpenseZ,
  ScheduleTaskZ,
  SurfForecastZ,
  AddPoiZ,
  toParsedExpense,
  type RecordExpenseInput,
  type LearnExpenseInput,
  type ScheduleTaskInput,
  type SurfForecastInput,
  type AddPoiInput,
} from './schema.js';
import type { Turn } from '../db/repos/conversation.repo.js';

export interface AssistantContext {
  defaultCurrency: string;
  members: { name: string; initials?: string }[];
  memory: string;
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
  /** Expose the schedule_task tool (default true; false for scheduled runs). */
  allowReminders?: boolean;
  /** Expose the add_poi tool (default true; false for scheduled runs). */
  allowPoi?: boolean;
  /** Saved places in this chat, shown so the model can recall them and not duplicate. */
  places?: { name: string; category: string }[];
  /** Learned slang/distorted words this chat uses, fed back so the bot talks like them. */
  lexicon?: { term: string; gloss?: string }[];
  history: Turn[];
  /** Plain text message, or image content blocks for a receipt photo. */
  userContent: string | Anthropic.ContentBlockParam[];
}

export interface AssistantHandlers {
  /** Persist a remembered note; return a short human confirmation. */
  remember: (note: string) => string;
  /** Add trigger words to the chat's expense dictionary; return a confirmation. */
  learnExpense: (input: LearnExpenseInput) => string;
  /** Create a reminder / recurring task; return a short human confirmation. */
  scheduleTask: (input: ScheduleTaskInput) => string;
  /** Fetch a wave forecast for the given spots; return a compact data summary. */
  surfForecast: (input: SurfForecastInput) => Promise<string>;
  /** Save a point of interest; return a short human confirmation. */
  addPoi: (input: AddPoiInput) => string;
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
    enableExpenseLearning: ctx.allowExpenseLearning !== false,
    enableReminders: ctx.allowReminders !== false,
    enableSurf: cfg.ENABLE_SURF,
    enablePoi: ctx.allowPoi !== false,
  });

  const contextBlock = buildContextBlock({
    defaultCurrency: ctx.defaultCurrency,
    members: ctx.members,
    memory: ctx.memory,
    senderName: ctx.senderName,
    timezone: ctx.timezone,
    splidConnected: ctx.splidConnected,
    activeReminders: ctx.activeReminders ?? [],
    places: ctx.places ?? [],
    lexicon: ctx.lexicon ?? [],
  });

  let scheduled = false;
  // Tracks whether any tool ran this turn. A plain-chat answer (no tools) is the
  // only thing safe to hand to the tone-only humorizer downstream.
  let usedTool = false;

  const messages: Anthropic.MessageParam[] = [];
  for (const turn of ctx.history) {
    messages.push({ role: turn.role, content: turn.content });
  }

  const currentContent: Anthropic.ContentBlockParam[] = [
    { type: 'text', text: contextBlock },
  ];
  if (typeof ctx.userContent === 'string') {
    currentContent.push({ type: 'text', text: ctx.userContent });
  } else {
    currentContent.push(...ctx.userContent);
  }
  messages.push({ role: 'user', content: currentContent });

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const res = await anthropic.messages.create({
      model: cfg.ANTHROPIC_MODEL,
      max_tokens: 2048,
      // Cache the stable prefix (tools render before system, so one breakpoint on
      // the system block caches both tool schemas + system prompt). Re-reads cost
      // ~0.1x: this is the main lever against per-call token cost.
      system: [
        { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
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

    if (res.stop_reason === 'tool_use') {
      usedTool = true;
      messages.push({ role: 'assistant', content: res.content });
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of res.content) {
        if (block.type !== 'tool_use') continue;
        if (block.name === REMEMBER_TOOL) {
          const parsed = RememberZ.safeParse(block.input);
          const confirmation = parsed.success
            ? handlers.remember(parsed.data.note)
            : 'Could not parse the note.';
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
    return { kind: 'text', text: text || '…', scheduled, humorizable: !usedTool };
  }

  return { kind: 'text', text: 'Что-то пошло не так, попробуй ещё раз.', scheduled };
}
