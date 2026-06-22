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
  it('always exposes remember and schedule_task (general secretary, no Splid needed)', () => {
    const tools = buildTools({ enableWebSearch: false, enableExpense: false });
    const got = names(tools);
    expect(got).toContain(REMEMBER_TOOL);
    expect(got).toContain(SCHEDULE_TASK_TOOL);
    for (const name of [REMEMBER_TOOL, SCHEDULE_TASK_TOOL]) {
      const tool = tools.find((t) => 'name' in t && t.name === name);
      expect('input_schema' in tool!).toBe(true);
    }
  });

  it('omits record_expense when Splid is not connected', () => {
    const got = names(buildTools({ enableWebSearch: true, enableExpense: false }));
    expect(got).not.toContain(RECORD_EXPENSE_TOOL);
  });

  it('exposes record_expense only when Splid is connected', () => {
    const got = names(buildTools({ enableWebSearch: false, enableExpense: true }));
    expect(got).toContain(RECORD_EXPENSE_TOOL);
  });

  it('omits web search when disabled', () => {
    expect(names(buildTools({ enableWebSearch: false, enableExpense: true }))).not.toContain(
      'web_search',
    );
  });

  it('adds the dynamic-filtering web_search variant when enabled', () => {
    const webSearch = buildTools({ enableWebSearch: true, enableExpense: false }).find(
      (t) => 'name' in t && t.name === 'web_search',
    );
    expect(webSearch).toBeDefined();
    // Guard the cost-saving variant: a downgrade to an older type should fail here.
    expect((webSearch as { type?: string }).type).toBe('web_search_20260209');
  });

  it('omits remember and schedule_task for scheduled runs (no self-spawning)', () => {
    const got = names(
      buildTools({
        enableWebSearch: true,
        enableExpense: false,
        enableRemember: false,
        enableReminders: false,
      }),
    );
    expect(got).not.toContain(REMEMBER_TOOL);
    expect(got).not.toContain(SCHEDULE_TASK_TOOL);
    expect(got).toContain('web_search'); // search still allowed when a task fires
  });
});
