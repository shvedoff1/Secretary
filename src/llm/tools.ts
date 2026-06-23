import type Anthropic from '@anthropic-ai/sdk';
import {
  recordExpenseJsonSchema,
  rememberJsonSchema,
  scheduleTaskJsonSchema,
  surfForecastJsonSchema,
  addPoiJsonSchema,
} from './schema.js';

export const RECORD_EXPENSE_TOOL = 'record_expense';
export const REMEMBER_TOOL = 'remember';
export const SCHEDULE_TASK_TOOL = 'schedule_task';
export const SURF_FORECAST_TOOL = 'surf_forecast';
export const ADD_POI_TOOL = 'add_poi';

export interface ToolOptions {
  enableWebSearch: boolean;
  /** Expose record_expense only where a Splid group is connected (it's an add-on). */
  enableExpense: boolean;
  /** Expose the remember tool. Default true; disabled for scheduled runs. */
  enableRemember?: boolean;
  /** Expose the schedule_task tool. Default true; disabled for scheduled runs so a
   *  firing reminder can't create more reminders. */
  enableReminders?: boolean;
  /** Expose the surf_forecast tool. Default true; stays on for scheduled runs so a
   *  recurring evening task can produce the "where to go tomorrow" report. */
  enableSurf?: boolean;
  /** Expose the add_poi tool. Default true; disabled for scheduled runs. */
  enablePoi?: boolean;
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
        'Save a durable note to long-term memory. ONLY call this when the user EXPLICITLY asks to remember/save something (e.g. "запомни…", "сохрани…", "remember that…"). Never auto-remember expenses, receipts, or casual chatter.',
      input_schema: rememberJsonSchema as unknown as Anthropic.Tool.InputSchema,
    });
  }

  if (opts.enableReminders !== false) {
    tools.push({
      name: SCHEDULE_TASK_TOOL,
      description:
        'Create a reminder or recurring task. Call this ONLY for a NEW request in the user\'s latest message (e.g. "напомни встать через 3 минуты", "каждое утро ищи прогноз волн и кидай сюда"). Convert the timing into a cron expression. The task `prompt` runs later WITHOUT chat history, so make it self-contained. Never recreate a reminder that already appears in "Active reminders" in the context. Confirm timezone with the user once if it is unknown in the context.',
      input_schema: scheduleTaskJsonSchema as unknown as Anthropic.Tool.InputSchema,
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

  if (opts.enableWebSearch) {
    // _20260209 adds dynamic result filtering — Claude filters results before they
    // hit the context window, cutting tokens on search-heavy turns. Supported on
    // Opus 4.8 (current default) and Sonnet 4.6.
    tools.push({ type: 'web_search_20260209', name: 'web_search', max_uses: 5 });
  }

  return tools;
}
