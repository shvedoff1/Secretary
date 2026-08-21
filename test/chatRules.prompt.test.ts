import { describe, it, expect } from 'vitest';
import {
  FORWARDED_MESSAGE_MARKER,
  SYSTEM_PROMPT,
  ASSISTANT_SYSTEM_PROMPT,
  TUTOR_SYSTEM_PROMPT,
  VOICE_TRANSCRIPT_MARKER,
  buildContextBlock,
  buildTutorContextBlock,
} from '../src/llm/prompts.js';
import { buildTools, SET_RULE_TOOL } from '../src/llm/tools.js';
import { SetRuleZ } from '../src/llm/schema.js';

function base() {
  return {
    defaultCurrency: 'EUR',
    members: [],
    senderName: 'Тестер',
    timezone: 'Europe/Moscow',
    splidConnected: false,
  };
}

// Chat rules are STANDING ORDERS injected into every turn. If they stop being
// rendered — or stop reading as orders — the bot silently goes back to its own
// habits, which is exactly the failure this feature exists to prevent.
describe('chat rules in the context block', () => {
  it('renders the rules as a numbered order list, above memory', () => {
    const block = buildContextBlock({
      ...base(),
      rules: ['Все голосовые расшифровывай и чисти от слов-паразитов', 'Отвечай короче'],
      memoryChat: [{ content: 'Мы живём на Бали' }],
    });
    expect(block).toContain('Chat rules');
    expect(block).toContain('1. Все голосовые расшифровывай и чисти от слов-паразитов');
    expect(block).toContain('2. Отвечай короче');
    // Orders come before the facts — the model must not have to dig for them.
    expect(block.indexOf('Chat rules')).toBeLessThan(block.indexOf('Chat memory'));
    // And they are framed as binding, not as context.
    expect(block).toMatch(/STANDING ORDERS/);
  });

  it('renders nothing at all for a chat with no rules', () => {
    const block = buildContextBlock({ ...base(), rules: [] });
    expect(block).not.toContain('Chat rules');
    expect(buildContextBlock(base())).not.toContain('Chat rules');
  });

  it('applies to a tutor chat too', () => {
    const block = buildTutorContextBlock({
      senderName: 'Ученик',
      timezone: 'Europe/Moscow',
      rules: ['Сначала подсказка, решение только если попрошу'],
    });
    expect(block).toContain('Chat rules');
    expect(block).toContain('1. Сначала подсказка');
  });
});

describe('SYSTEM_PROMPT rule guidance', () => {
  it('documents set_rule and the rule-vs-fact-vs-reminder split', () => {
    expect(SYSTEM_PROMPT).toContain('set_rule');
    expect(SYSTEM_PROMPT).toContain('Chat rules');
    // A fact is memory, a timing is a schedule — the two misroutes that matter.
    expect(SYSTEM_PROMPT).toMatch(/a FACT to know is .?remember/);
    expect(SYSTEM_PROMPT).toMatch(/TIME-based.*schedule_task/);
  });

  it('says rules outrank the default style but never accuracy', () => {
    expect(SYSTEM_PROMPT).toMatch(/outrank\s+your own habits/);
    expect(SYSTEM_PROMPT).toMatch(/never override accuracy/);
  });

  it('explains the voice-transcript marker verbatim, so a rule can key on it', () => {
    // The marker string is applied in the flow and explained here — they must match.
    expect(SYSTEM_PROMPT).toContain(VOICE_TRANSCRIPT_MARKER);
    expect(SYSTEM_PROMPT).toContain('слов-паразитов');
  });
});

describe('SYSTEM_PROMPT forwarded-message guidance', () => {
  it('explains the forwarded marker verbatim, so a rule can key on it', () => {
    // The marker is applied in the flow and explained here — they must match.
    expect(SYSTEM_PROMPT).toContain(FORWARDED_MESSAGE_MARKER);
  });

  it('says a forward is not the sender’s own words or spend, and that rules win', () => {
    expect(SYSTEM_PROMPT).toMatch(/never attribute the\s+content to the sender/);
    expect(SYSTEM_PROMPT).toContain('пересланных');
  });
});

describe('ASSISTANT_SYSTEM_PROMPT (calm mode persona)', () => {
  it('keeps the shared behaviour rules and overrides only the persona', () => {
    // Built on top of the secretary prompt, so tools/rules/naming rules are shared
    // and the string stays prompt-cacheable as its own prefix.
    expect(ASSISTANT_SYSTEM_PROMPT.startsWith(SYSTEM_PROMPT)).toBe(true);
    expect(ASSISTANT_SYSTEM_PROMPT).toContain('РЕЖИМ «АССИСТЕНТ»');
    expect(ASSISTANT_SYSTEM_PROMPT).toContain('set_rule');
  });

  it('bans the jokes and the surfer voice, and points behaviour at the chat rules', () => {
    const override = ASSISTANT_SYSTEM_PROMPT.slice(SYSTEM_PROMPT.length);
    expect(override).toContain('Никаких шуток');
    expect(override).toContain('чилл');
    expect(override).toContain('ПРАВИЛА ЧАТА');
    expect(override).toContain('Style');
  });

  it('is not the tutor prompt (different mode, different trade-offs)', () => {
    expect(ASSISTANT_SYSTEM_PROMPT).not.toBe(TUTOR_SYSTEM_PROMPT);
  });
});

describe('set_rule tool', () => {
  it('is exposed by default and hidden for scheduled runs', () => {
    const names = (opts: Parameters<typeof buildTools>[0]) =>
      buildTools(opts).map((t) => ('name' in t ? t.name : ''));
    expect(names({ enableWebSearch: false, enableExpense: false })).toContain(SET_RULE_TOOL);
    // A firing task must not be able to rewrite how the bot behaves in the chat.
    expect(
      names({ enableWebSearch: false, enableExpense: false, enableRules: false }),
    ).not.toContain(SET_RULE_TOOL);
  });

  it('accepts add/remove with text and rejects anything else', () => {
    expect(SetRuleZ.safeParse({ action: 'add', text: 'Отвечай короче' }).success).toBe(true);
    expect(SetRuleZ.safeParse({ action: 'remove', text: 'Отвечай короче' }).success).toBe(true);
    expect(SetRuleZ.safeParse({ action: 'clear', text: 'x' }).success).toBe(false);
    expect(SetRuleZ.safeParse({ action: 'add', text: '' }).success).toBe(false);
    expect(SetRuleZ.safeParse({ action: 'add' }).success).toBe(false);
  });
});
