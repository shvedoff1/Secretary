import type Anthropic from '@anthropic-ai/sdk';
import {
  recordExpenseJsonSchema,
  rememberJsonSchema,
  scheduleTaskJsonSchema,
} from './schema.js';

export const RECORD_EXPENSE_TOOL = 'record_expense';
export const REMEMBER_TOOL = 'remember';
export const SCHEDULE_TASK_TOOL = 'schedule_task';

export interface ToolOptions {
  enableWebSearch: boolean;
  /** Expose record_expense only where a Splid group is connected (it's an add-on). */
  enableExpense: boolean;
  /** Expose the remember tool. Default true; disabled for scheduled runs. */
  enableRemember?: boolean;
  /** Expose the schedule_task tool. Default true; disabled for scheduled runs so a
   *  firing reminder can't create more reminders. */
  enableReminders?: boolean;
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

  if (opts.enableWebSearch) {
    // _20260209 adds dynamic result filtering — Claude filters results before they
    // hit the context window, cutting tokens on search-heavy turns. Supported on
    // Opus 4.8 (current default) and Sonnet 4.6.
    tools.push({ type: 'web_search_20260209', name: 'web_search', max_uses: 5 });
  }

  return tools;
}
