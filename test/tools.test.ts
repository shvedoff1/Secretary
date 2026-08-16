import { describe, it, expect } from 'vitest';
import {
  buildTools,
  RECORD_EXPENSE_TOOL,
  REMEMBER_TOOL,
  EDIT_MEMORY_TOOL,
  LEARN_EXPENSE_TOOL,
  EDIT_LEXICON_TOOL,
  EDIT_PING_LIST_TOOL,
  SCHEDULE_TASK_TOOL,
  WATCH_PAGE_TOOL,
  DOTA_LOOKUP_TOOL,
  ADD_POI_TOOL,
  SPENDING_REPORT_TOOL,
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

  it('exposes edit_memory by default and omits it for scheduled runs', () => {
    expect(names(buildTools({ enableWebSearch: false, enableExpense: false }))).toContain(
      EDIT_MEMORY_TOOL,
    );
    const scheduled = names(
      buildTools({ enableWebSearch: true, enableExpense: false, enableMemoryEdit: false }),
    );
    expect(scheduled).not.toContain(EDIT_MEMORY_TOOL);
  });

  it('exposes learn_expense_pattern by default (any chat) and omits it for scheduled runs', () => {
    const got = names(buildTools({ enableWebSearch: false, enableExpense: false }));
    expect(got).toContain(LEARN_EXPENSE_TOOL);
    const tool = buildTools({ enableWebSearch: false, enableExpense: false }).find(
      (t) => 'name' in t && t.name === LEARN_EXPENSE_TOOL,
    );
    expect('input_schema' in tool!).toBe(true);

    const scheduled = names(
      buildTools({
        enableWebSearch: true,
        enableExpense: false,
        enableExpenseLearning: false,
      }),
    );
    expect(scheduled).not.toContain(LEARN_EXPENSE_TOOL);
  });

  it('exposes add_poi by default and omits it when disabled', () => {
    expect(names(buildTools({ enableWebSearch: false, enableExpense: false }))).toContain(
      ADD_POI_TOOL,
    );
    const scheduled = names(
      buildTools({ enableWebSearch: true, enableExpense: false, enablePoi: false }),
    );
    expect(scheduled).not.toContain(ADD_POI_TOOL);
  });

  it('exposes edit_lexicon by default and omits it for scheduled runs', () => {
    expect(names(buildTools({ enableWebSearch: false, enableExpense: false }))).toContain(
      EDIT_LEXICON_TOOL,
    );
    const tool = buildTools({ enableWebSearch: false, enableExpense: false }).find(
      (t) => 'name' in t && t.name === EDIT_LEXICON_TOOL,
    );
    expect('input_schema' in tool!).toBe(true);

    const scheduled = names(
      buildTools({ enableWebSearch: true, enableExpense: false, enableLexiconEdit: false }),
    );
    expect(scheduled).not.toContain(EDIT_LEXICON_TOOL);
  });

  it('exposes edit_ping_list by default and omits it for scheduled runs', () => {
    expect(names(buildTools({ enableWebSearch: false, enableExpense: false }))).toContain(
      EDIT_PING_LIST_TOOL,
    );
    const tool = buildTools({ enableWebSearch: false, enableExpense: false }).find(
      (t) => 'name' in t && t.name === EDIT_PING_LIST_TOOL,
    );
    expect('input_schema' in tool!).toBe(true);

    const scheduled = names(
      buildTools({ enableWebSearch: true, enableExpense: false, enablePingEdit: false }),
    );
    expect(scheduled).not.toContain(EDIT_PING_LIST_TOOL);
  });

  it('steers page-watch requests away from schedule_task (anti-misroute guard)', () => {
    // Regression: «следи за <url> и напиши, когда появятся сеансы» once landed in
    // schedule_task as a DAILY cron check. The steering lives in the tool
    // descriptions the model reads — keep both sides of the fence standing.
    const tools = buildTools({ enableWebSearch: false, enableExpense: false });
    const scheduleTask = tools.find((t) => 'name' in t && t.name === SCHEDULE_TASK_TOOL);
    const watchPage = tools.find((t) => 'name' in t && t.name === WATCH_PAGE_TOOL);
    expect((scheduleTask as { description?: string }).description).toContain('watch_page');
    expect((watchPage as { description?: string }).description).toContain('schedule_task');
  });

  it('exposes watch_page by default and omits it for scheduled runs', () => {
    expect(names(buildTools({ enableWebSearch: false, enableExpense: false }))).toContain(
      WATCH_PAGE_TOOL,
    );
    const tool = buildTools({ enableWebSearch: false, enableExpense: false }).find(
      (t) => 'name' in t && t.name === WATCH_PAGE_TOOL,
    );
    expect('input_schema' in tool!).toBe(true);

    const scheduled = names(
      buildTools({ enableWebSearch: true, enableExpense: false, enableWatch: false }),
    );
    expect(scheduled).not.toContain(WATCH_PAGE_TOOL);
  });

  it('exposes spending_report only when enabled (a Splid group is connected)', () => {
    expect(
      names(buildTools({ enableWebSearch: false, enableExpense: false })),
    ).not.toContain(SPENDING_REPORT_TOOL);
    const got = names(
      buildTools({ enableWebSearch: false, enableExpense: true, enableSpending: true }),
    );
    expect(got).toContain(SPENDING_REPORT_TOOL);
    const tool = buildTools({
      enableWebSearch: false,
      enableExpense: true,
      enableSpending: true,
    }).find((t) => 'name' in t && t.name === SPENDING_REPORT_TOOL);
    expect('input_schema' in tool!).toBe(true);
  });

  it('exposes dota_lookup only when the chat is in dota mode', () => {
    // Off by default: keeping it out of every other chat's tool list leaves
    // their cached prompt prefix untouched.
    expect(
      names(buildTools({ enableWebSearch: false, enableExpense: false })),
    ).not.toContain(DOTA_LOOKUP_TOOL);

    const got = names(
      buildTools({ enableWebSearch: false, enableExpense: false, enableDota: true }),
    );
    expect(got).toContain(DOTA_LOOKUP_TOOL);
    const tool = buildTools({
      enableWebSearch: false,
      enableExpense: false,
      enableDota: true,
    }).find((t) => 'name' in t && t.name === DOTA_LOOKUP_TOOL);
    expect('input_schema' in tool!).toBe(true);
  });
});
