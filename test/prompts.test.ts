import { describe, it, expect } from 'vitest';
import { SYSTEM_PROMPT, buildContextBlock } from '../src/llm/prompts.js';

// Guard the web-search guidance so it can't be silently dropped (the model only
// searches when the prompt tells it to — there's no deterministic trigger).
describe('SYSTEM_PROMPT web-search guidance', () => {
  it('tells the model to always search when explicitly asked', () => {
    expect(SYSTEM_PROMPT).toContain('web_search');
    // An explicit request must force a search ("ALWAYS call web_search ...").
    expect(SYSTEM_PROMPT).toMatch(/ALWAYS call `?web_search/);
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('загугли');
  });
});

describe('SYSTEM_PROMPT lexicon guidance', () => {
  it('tells the model to adopt the chat lexicon', () => {
    expect(SYSTEM_PROMPT).toContain('Chat lexicon');
  });
});

describe('SYSTEM_PROMPT memory guidance', () => {
  it('tells the model about the chat-memory and per-person sections', () => {
    expect(SYSTEM_PROMPT).toContain('Chat memory');
    expect(SYSTEM_PROMPT).toContain('About <name>');
  });
});

// A receipt with items belonging to different people must split into several
// expenses, and "everyone except X" must be expanded from the roster — both were
// the cases the bot used to fluff, so guard the guidance against silent removal.
describe('SYSTEM_PROMPT receipt-splitting guidance', () => {
  it('tells the model to emit several record_expense calls per group', () => {
    expect(SYSTEM_PROMPT).toContain('GROUPS');
    expect(SYSTEM_PROMPT).toMatch(/SEVERAL\s+`?record_expense/);
  });

  it('tells the model to expand "everyone except X" from the roster', () => {
    expect(SYSTEM_PROMPT).toContain('EXCEPT');
  });
});

describe('buildContextBlock lexicon section', () => {
  const base = {
    defaultCurrency: 'EUR',
    members: [],
    memory: '',
    senderName: 'Sky',
    timezone: null,
    splidConnected: false,
  };

  it('renders learned slang with and without a gloss when present', () => {
    const out = buildContextBlock({
      ...base,
      lexicon: [
        { term: 'тип', gloss: 'типа' },
        { term: 'братик' },
      ],
    });
    expect(out).toContain('Chat lexicon');
    expect(out).toContain('«тип» — типа');
    expect(out).toContain('«братик»');
    expect(out).not.toContain('«братик» —');
  });

  it('omits the section entirely when there is no learned slang', () => {
    expect(buildContextBlock(base)).not.toContain('Chat lexicon');
    expect(buildContextBlock({ ...base, lexicon: [] })).not.toContain('Chat lexicon');
  });
});

describe('buildContextBlock memory sections', () => {
  const base = {
    defaultCurrency: 'EUR',
    members: [],
    senderName: 'Sky',
    timezone: null,
    splidConnected: false,
  };

  it('renders the shared chat-memory section and per-person sections', () => {
    const out = buildContextBlock({
      ...base,
      memoryChat: [{ content: 'едут на Бали' }],
      memoryUsers: [
        { subject: 'Sky', items: [{ content: 'любит серф' }] },
        { subject: 'Max', items: [{ content: 'веган' }] },
      ],
    });
    expect(out).toContain('Chat memory');
    expect(out).toContain('- едут на Бали');
    expect(out).toContain('About Sky');
    expect(out).toContain('- любит серф');
    expect(out).toContain('About Max');
    // The sender's section comes before other participants'.
    expect(out.indexOf('About Sky')).toBeLessThan(out.indexOf('About Max'));
  });

  it('omits memory sections entirely when empty (fresh chat stays clean)', () => {
    const out = buildContextBlock(base);
    expect(out).not.toContain('Chat memory');
    expect(out).not.toContain('About ');
    const out2 = buildContextBlock({ ...base, memoryChat: [], memoryUsers: [] });
    expect(out2).not.toContain('Chat memory');
  });
});
