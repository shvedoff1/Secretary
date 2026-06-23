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
