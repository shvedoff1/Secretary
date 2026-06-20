import type Anthropic from '@anthropic-ai/sdk';
import { recordExpenseJsonSchema, rememberJsonSchema } from './schema.js';

export const RECORD_EXPENSE_TOOL = 'record_expense';
export const REMEMBER_TOOL = 'remember';

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
        'Save a durable fact about this chat/group (trip context, preferences, corrections) to long-term memory.',
      input_schema: rememberJsonSchema as unknown as Anthropic.Tool.InputSchema,
    },
  ];

  if (enableWebSearch) {
    tools.push({ type: 'web_search_20250305', name: 'web_search', max_uses: 5 });
  }

  return tools;
}
