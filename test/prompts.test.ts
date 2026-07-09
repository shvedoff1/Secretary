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

// Slang now rides ONLY on the OpenAI humorizer, not Claude — Claude gets clean
// history/context. Guard that the lexicon block is gone from the model's prompt
// so it can't silently creep back in.
describe('SYSTEM_PROMPT no longer carries the chat lexicon', () => {
  it('does not reference a "Chat lexicon" block (slang moved to the humorizer)', () => {
    expect(SYSTEM_PROMPT).not.toContain('Chat lexicon');
  });
});

describe('SYSTEM_PROMPT memory guidance', () => {
  it('tells the model about the chat-memory and per-person sections', () => {
    expect(SYSTEM_PROMPT).toContain('Chat memory');
    expect(SYSTEM_PROMPT).toContain('About <name>');
  });

  it('tells the model to follow the voice/style section', () => {
    expect(SYSTEM_PROMPT).toContain('Voice & style');
  });

  it('tells the model to override contradictions via replaces, after one pushback', () => {
    expect(SYSTEM_PROMPT).toContain('replaces');
    expect(SYSTEM_PROMPT).toMatch(/push back ONCE/);
    expect(SYSTEM_PROMPT).toContain('edit_memory');
  });

  it('carves the written-memory exception into the accept-facts rule', () => {
    // A plain factual correction is still accepted, but a contradiction of WRITTEN
    // memory may earn one pushback — guard that the carve-out is present.
    expect(SYSTEM_PROMPT).toMatch(/WRITTEN in the chat memory/);
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

  // The sender often names themselves in the third person by name/nickname and
  // mixes it with "я"/"у меня" («Андрей это швед, платил я»); the model used to
  // spawn a phantom member and stall over who paid. Guard the self-reference note.
  it('tells the model to fold the sender\'s own name/nickname into "я"', () => {
    expect(SYSTEM_PROMPT).toContain('SELF-REFERENCE');
    expect(SYSTEM_PROMPT).toMatch(/third person/);
  });
});

// The bot used to instantly agree with any pushback. It should now defend its own
// take 1-2 times before conceding — but ONLY for opinions/banter, never for facts
// or task data (reminder times, expense amounts, who splits). Guard both halves so
// the resistance can't creep into factual corrections or get silently dropped.
describe('SYSTEM_PROMPT argument-resistance guidance', () => {
  it('tells the model to hold its position for 1-2 rounds before conceding', () => {
    expect(SYSTEM_PROMPT).toContain('Standing your ground');
    expect(SYSTEM_PROMPT).toMatch(/1-2 rounds/);
    expect(SYSTEM_PROMPT).toMatch(/do NOT\s+instantly cave/);
  });

  it('scopes resistance to opinions only — never facts or task data', () => {
    expect(SYSTEM_PROMPT).toMatch(/ONLY for opinions/);
    expect(SYSTEM_PROMPT).toMatch(/NEVER argue about task data/);
    // A corrected fact must be accepted, not argued.
    expect(SYSTEM_PROMPT).toMatch(/corrects a FACT/);
  });
});

// The bot mixed people up in groups and @-tagged the wrong person. Guard the
// guidance that explains the "Name: message" labelling and forbids @-mentions.
describe('SYSTEM_PROMPT name & mention guidance', () => {
  it('explains that each message is prefixed with its author name', () => {
    expect(SYSTEM_PROMPT).toContain("Who's talking");
    expect(SYSTEM_PROMPT).toMatch(/prefixed with its author'?s name/);
  });

  it('forbids @-tagging so it never pings the wrong person', () => {
    expect(SYSTEM_PROMPT).toMatch(/@-tag|@-mention/);
    expect(SYSTEM_PROMPT).toContain('WRONG person');
  });
});

describe('buildContextBlock never carries slang', () => {
  const base = {
    defaultCurrency: 'EUR',
    members: [],
    senderName: 'Sky',
    timezone: null,
    splidConnected: false,
  };

  it('renders no lexicon section (slang lives on the humorizer now)', () => {
    const out = buildContextBlock(base);
    expect(out).not.toContain('Chat lexicon');
    expect(out).not.toContain('lexicon');
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
    expect(out).not.toContain('Voice & style');
    const out2 = buildContextBlock({ ...base, memoryChat: [], memoryUsers: [] });
    expect(out2).not.toContain('Chat memory');
  });

  it('renders the voice/style section separately from facts', () => {
    const out = buildContextBlock({
      ...base,
      memoryPersona: [{ content: 'говори как серфер, эмодзи 🤙 уместны' }],
      memoryChat: [{ content: 'едут на Бали' }],
    });
    expect(out).toContain('Voice & style for this chat');
    expect(out).toContain('- говори как серфер, эмодзи 🤙 уместны');
    // Style comes before the factual chat memory.
    expect(out.indexOf('Voice & style')).toBeLessThan(out.indexOf('Chat memory'));
  });
});
