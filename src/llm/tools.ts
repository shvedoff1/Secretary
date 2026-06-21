import type Anthropic from '@anthropic-ai/sdk';
import {
  recordExpenseJsonSchema,
  rememberJsonSchema,
  scheduleTaskJsonSchema,
} from './schema.js';

export const RECORD_EXPENSE_TOOL = 'record_expense';
export const REMEMBER_TOOL = 'remember';
export const SCHEDULE_TASK_TOOL = 'schedule_task';

export function buildTools(enableWebSearch: boolean): Anthropic.ToolUnion[] {
  const tools: Anthropic.ToolUnion[] = [
    {
      name: RECORD_EXPENSE_TOOL,
      description:
        'Propose a shared expense to be recorded (after user confirmation). Call this whenever a message or receipt describes a purchase to split.',
      input_schema: recordExpenseJsonSchema as unknown as Anthropic.Tool.InputSchema,
    },
    {
      name: REMEMBER_TOOL,
      description:
        'Save a durable note to long-term memory. ONLY call this when the user EXPLICITLY asks to remember/save something (e.g. "запомни…", "сохрани…", "remember that…"). Never auto-remember expenses, receipts, or casual chatter.',
      input_schema: rememberJsonSchema as unknown as Anthropic.Tool.InputSchema,
    },
    {
      name: SCHEDULE_TASK_TOOL,
      description:
        'Create a reminder or recurring task. Call this when the user asks to be reminded or to run something on a schedule (e.g. "напомни завтра в 9…", "каждое утро ищи прогноз волн и кидай сюда"). Convert the timing into a cron expression. The task `prompt` runs later WITHOUT chat history, so make it self-contained. Confirm timezone with the user once if it is unknown in the context.',
      input_schema: scheduleTaskJsonSchema as unknown as Anthropic.Tool.InputSchema,
    },
  ];

  if (enableWebSearch) {
    // _20260209 adds dynamic result filtering — Claude filters results before they
    // hit the context window, cutting tokens on search-heavy turns. Supported on
    // Opus 4.8 (current default) and Sonnet 4.6.
    tools.push({ type: 'web_search_20260209', name: 'web_search', max_uses: 5 });
  }

  return tools;
}
