import type Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { getAnthropic } from './client.js';
import { SYSTEM_PROMPT, buildContextBlock } from './prompts.js';
import {
  buildTools,
  RECORD_EXPENSE_TOOL,
  REMEMBER_TOOL,
  SCHEDULE_TASK_TOOL,
  SURF_FORECAST_TOOL,
  ADD_POI_TOOL,
} from './tools.js';
import {
  RecordExpenseZ,
  RememberZ,
  ScheduleTaskZ,
  SurfForecastZ,
  AddPoiZ,
  toParsedExpense,
  type RecordExpenseInput,
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
  /** Expose the schedule_task tool (default true; false for scheduled runs). */
  allowReminders?: boolean;
  /** Expose the add_poi tool (default true; false for scheduled runs). */
  allowPoi?: boolean;
  /** Saved places in this chat, shown so the model can recall them and not duplicate. */
  places?: { name: string; category: string }[];
  history: Turn[];
  /** Plain text message, or image content blocks for a receipt photo. */
  userContent: string | Anthropic.ContentBlockParam[];
}

export interface AssistantHandlers {
  /** Persist a remembered note; return a short human confirmation. */
  remember: (note: string) => string;
  /** Create a reminder / recurring task; return a short human confirmation. */
  scheduleTask: (input: ScheduleTaskInput) => string;
  /** Fetch a wave forecast for the given spots; return a compact data summary. */
  surfForecast: (input: SurfForecastInput) => Promise<string>;
  /** Save a point of interest; return a short human confirmation. */
  addPoi: (input: AddPoiInput) => string;
}

export type AssistantResult =
  | { kind: 'expense'; input: RecordExpenseInput }
  // `scheduled` marks a turn that created/handled a reminder, so the caller can
  // keep it out of conversation history (a lingering request would re-fire).
  | { kind: 'text'; text: string; scheduled?: boolean };

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
  });

  let scheduled = false;

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
    // human confirmation, so we stop and let the bot render a preview.
    const recordBlock = res.content.find(
      (b): b is Anthropic.ToolUseBlock =>
        b.type === 'tool_use' && b.name === RECORD_EXPENSE_TOOL,
    );
    if (recordBlock) {
      const parsed = RecordExpenseZ.safeParse(recordBlock.input);
      if (parsed.success) return { kind: 'expense', input: parsed.data };
      logger.warn({ err: parsed.error }, 'record_expense input failed validation');
      return {
        kind: 'text',
        text: 'Не смог разобрать трату — попробуй сформулировать иначе (сумма, на кого делим).',
      };
    }

    if (res.stop_reason === 'tool_use') {
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
      // Server-side tool (web_search) hit the loop limit — resume.
      messages.push({ role: 'assistant', content: res.content });
      continue;
    }

    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    return { kind: 'text', text: text || '…', scheduled };
  }

  return { kind: 'text', text: 'Что-то пошло не так, попробуй ещё раз.', scheduled };
}
