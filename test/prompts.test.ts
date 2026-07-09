import { describe, it, expect } from 'vitest';
import {
  CORE_PROMPT,
  SURF_FRAGMENT,
  buildSystemPrompt,
  buildContextBlock,
  personaStyleFor,
} from '../src/llm/prompts.js';
import { getPreset } from '../src/persona/presets.js';

// Guard the web-search guidance so it can't be silently dropped (the model only
// searches when the prompt tells it to — there's no deterministic trigger).
describe('CORE_PROMPT web-search guidance', () => {
  it('tells the model to always search when explicitly asked', () => {
    expect(CORE_PROMPT).toContain('web_search');
    // An explicit request must force a search ("ALWAYS call web_search ...").
    expect(CORE_PROMPT).toMatch(/ALWAYS call `?web_search/);
    expect(CORE_PROMPT.toLowerCase()).toContain('загугли');
  });
});

// Slang now rides ONLY on the OpenAI humorizer, not Claude — Claude gets clean
// history/context. Guard that the lexicon block is gone from the model's prompt
// so it can't silently creep back in.
describe('CORE_PROMPT no longer carries the chat lexicon', () => {
  it('does not reference a "Chat lexicon" block (slang moved to the humorizer)', () => {
    expect(CORE_PROMPT).not.toContain('Chat lexicon');
  });
});

describe('CORE_PROMPT memory guidance', () => {
  it('tells the model about the chat-memory and per-person sections', () => {
    expect(CORE_PROMPT).toContain('Chat memory');
    expect(CORE_PROMPT).toContain('About <name>');
  });

  it('tells the model to follow the voice/style section', () => {
    expect(CORE_PROMPT).toContain('Voice & style');
  });

  it('tells the model to override contradictions via replaces, after one pushback', () => {
    expect(CORE_PROMPT).toContain('replaces');
    expect(CORE_PROMPT).toMatch(/push back ONCE/);
    expect(CORE_PROMPT).toContain('edit_memory');
  });
});

// A receipt with items belonging to different people must split into several
// expenses, and "everyone except X" must be expanded from the roster — both were
// the cases the bot used to fluff, so guard the guidance against silent removal.
describe('CORE_PROMPT receipt-splitting guidance', () => {
  it('tells the model to emit several record_expense calls per group', () => {
    expect(CORE_PROMPT).toContain('GROUPS');
    expect(CORE_PROMPT).toMatch(/SEVERAL\s+`?record_expense/);
  });

  it('tells the model to expand "everyone except X" from the roster', () => {
    expect(CORE_PROMPT).toContain('EXCEPT');
  });

  // The sender often names themselves in the third person by name/nickname and
  // mixes it with "я"/"у меня" («Андрей это швед, платил я»); the model used to
  // spawn a phantom member and stall over who paid. Guard the self-reference note.
  it('tells the model to fold the sender\'s own name/nickname into "я"', () => {
    expect(CORE_PROMPT).toContain('SELF-REFERENCE');
    expect(CORE_PROMPT).toMatch(/third person/);
  });
});

// Surf is now an OPTIONAL skill fragment, appended only when ENABLE_SURF is on. The
// neutral core must NOT describe surf, so a fresh fork's model never sees it.
describe('buildSystemPrompt surf fragment gating', () => {
  it('keeps surf out of the neutral core', () => {
    expect(CORE_PROMPT).not.toContain('surf_forecast');
    expect(CORE_PROMPT.toLowerCase()).not.toContain('wave');
  });

  it('omits the surf fragment when disabled', () => {
    const prompt = buildSystemPrompt({ enableSurf: false });
    expect(prompt).not.toContain('surf_forecast');
    expect(prompt).toBe(CORE_PROMPT);
  });

  it('appends the surf fragment when enabled', () => {
    const prompt = buildSystemPrompt({ enableSurf: true });
    expect(prompt).toContain(SURF_FRAGMENT);
    expect(prompt).toContain('surf_forecast');
    expect(prompt).toContain('TIDES MATTER');
  });
});

// The chill preset carries the "have a bit of backbone" banter behavior that used
// to be baked into the core prompt. It must NOT be in the neutral core, and it must
// still scope resistance to opinions only, never facts/task data.
describe('persona presets: chill backbone', () => {
  it('moves the backbone banter out of the neutral core', () => {
    expect(CORE_PROMPT).not.toContain('backbone');
    expect(CORE_PROMPT).not.toMatch(/Standing your ground/i);
  });

  it('gives the chill preset backbone that never argues facts or task data', () => {
    const chill = getPreset('chill')!;
    expect(chill.style).toMatch(/backbone/i);
    expect(chill.style).toMatch(/1-2 rounds/);
    expect(chill.style).toMatch(/NEVER for facts/);
  });

  it('keeps the neutral preset styleless (uses the core baseline voice)', () => {
    expect(getPreset('neutral')!.style).toBe('');
  });
});

describe('personaStyleFor', () => {
  it('resolves a known preset id to its style text', () => {
    expect(personaStyleFor('chill')).toMatch(/chill mate/i);
    expect(personaStyleFor('formal')).toMatch(/professional/i);
  });

  it('returns empty for the neutral preset', () => {
    expect(personaStyleFor('neutral')).toBe('');
  });

  it('falls back to neutral for an unknown or missing id', () => {
    expect(personaStyleFor('does-not-exist')).toBe('');
    expect(personaStyleFor(null)).toBe('');
    expect(personaStyleFor(undefined)).toBe('');
  });
});

// The bot mixed people up in groups and @-tagged the wrong person. Guard the
// guidance that explains the "Name: message" labelling and forbids @-mentions.
describe('CORE_PROMPT name & mention guidance', () => {
  it('explains that each message is prefixed with its author name', () => {
    expect(CORE_PROMPT).toContain("Who's talking");
    expect(CORE_PROMPT).toMatch(/prefixed with its author'?s name/);
  });

  it('forbids @-tagging so it never pings the wrong person', () => {
    expect(CORE_PROMPT).toMatch(/@-tag|@-mention/);
    expect(CORE_PROMPT).toContain('WRONG person');
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

  it('renders the selected persona style at the top of the voice section', () => {
    const out = buildContextBlock({
      ...base,
      personaStyle: personaStyleFor('chill'),
      memoryPersona: [{ content: 'зови всех «капитан»' }],
    });
    expect(out).toContain('Voice & style for this chat');
    expect(out).toMatch(/chill mate/i);
    // The preset baseline comes before the chat-curated tweak.
    expect(out.indexOf('chill mate')).toBeLessThan(out.indexOf('зови всех'));
  });

  it('shows no voice section for the neutral persona with no curated style', () => {
    const out = buildContextBlock({ ...base, personaStyle: personaStyleFor('neutral') });
    expect(out).not.toContain('Voice & style');
  });
});
