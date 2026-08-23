import { describe, it, expect } from 'vitest';
import { SYSTEM_PROMPT, buildContextBlock } from '../src/llm/prompts.js';

// «Кто ты и чей ты?» — the bot must be able to answer politely and name who it
// reports to. That takes two halves pinned together: the "Bot admins" line in
// the context block (real names) and the "Who you are" section of the system
// prompt that tells the model to use it.

const base = {
  defaultCurrency: 'EUR',
  members: [],
  senderName: 'Гоша',
  timezone: null,
  splidConnected: false,
};

describe('bot identity ("кто ты?")', () => {
  it('SYSTEM_PROMPT pins the who-you-are rule to the Bot admins context line', () => {
    expect(SYSTEM_PROMPT).toContain('Who you are');
    expect(SYSTEM_PROMPT).toContain('"Bot admins"');
    expect(SYSTEM_PROMPT).toContain('who you report to');
  });

  it('renders the admins into the context block', () => {
    const block = buildContextBlock({
      ...base,
      botAdmins: ['Швед (верховный админ)', 'Петя (админ этого чата)'],
    });
    expect(block).toContain(
      'Bot admins (who you report to): Швед (верховный админ), Петя (админ этого чата)',
    );
  });

  it('renders no admins line when there are none to name', () => {
    const block = buildContextBlock({ ...base, botAdmins: [] });
    expect(block).not.toContain('Bot admins');
  });

  it('the expense-only scan carries no admins (conversation-only context)', () => {
    const block = buildContextBlock({
      ...base,
      botAdmins: ['Швед (верховный админ)'],
      expenseOnly: true,
    });
    expect(block).not.toContain('Bot admins');
  });
});
