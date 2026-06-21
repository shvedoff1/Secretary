import { describe, it, expect } from 'vitest';
import {
  buildTools,
  RECORD_EXPENSE_TOOL,
  REMEMBER_TOOL,
  SCHEDULE_TASK_TOOL,
} from '../src/llm/tools.js';

function names(tools: ReturnType<typeof buildTools>): string[] {
  return tools.map((t) => ('name' in t ? t.name : '(unnamed)'));
}

describe('buildTools', () => {
  it('exposes the custom tools with input schemas', () => {
    const tools = buildTools(false);
    for (const name of [RECORD_EXPENSE_TOOL, REMEMBER_TOOL, SCHEDULE_TASK_TOOL]) {
      const tool = tools.find((t) => 'name' in t && t.name === name);
      expect(tool, `missing tool ${name}`).toBeDefined();
      expect('input_schema' in tool!).toBe(true);
    }
  });

  it('omits web search when disabled', () => {
    expect(names(buildTools(false))).not.toContain('web_search');
  });

  it('adds the dynamic-filtering web_search variant when enabled', () => {
    const webSearch = buildTools(true).find(
      (t) => 'name' in t && t.name === 'web_search',
    );
    expect(webSearch).toBeDefined();
    // Guard the cost-saving variant: a downgrade to an older type should fail here.
    expect((webSearch as { type?: string }).type).toBe('web_search_20260209');
  });
});
