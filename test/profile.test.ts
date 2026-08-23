import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parseProfileJson } from '../src/llm/profile.js';
import { renderFactLine } from '../src/episodes/profileRefresh.js';
import { buildContextBlock, SYSTEM_PROMPT } from '../src/llm/prompts.js';
import type { MemoryItem } from '../src/db/repos/memoryItem.repo.js';

// Profile cards: the maintained portrait of the chat and its people, refreshed at
// episode close. The parser is the write gate — bad model output must keep the
// old cards, never replace them with garbage.

describe('parseProfileJson', () => {
  const opts = { maxCards: 8, maxChars: 100 };

  it('parses cards, including the chat card (empty subject)', () => {
    const out = parseProfileJson(
      '{"cards":[{"subject":"","content":"чат про сёрф"},{"subject":"Гоша","content":"серфит\\nсейчас во Вьетнаме"}]}',
      opts,
    );
    expect(out).toEqual([
      { subject: '', content: 'чат про сёрф' },
      { subject: 'Гоша', content: 'серфит\nсейчас во Вьетнаме' },
    ]);
  });

  it('returns null on garbage (old cards must stand)', () => {
    expect(parseProfileJson('не json', opts)).toBeNull();
    expect(parseProfileJson('{"cards": "oops"}', opts)).toBeNull();
    expect(parseProfileJson('{"nothing": []}', opts)).toBeNull();
  });

  it('accepts an empty change-set (nothing to update)', () => {
    expect(parseProfileJson('{"cards":[]}', opts)).toEqual([]);
  });

  it('drops blanks, dedups subjects case-insensitively, enforces caps', () => {
    const out = parseProfileJson(
      JSON.stringify({
        cards: [
          { subject: 'Гоша', content: 'x'.repeat(500) },
          { subject: 'гоша', content: 'дубль' },
          { subject: 'Пустой', content: '   ' },
          { subject: 42, content: 'не строка' },
        ],
      }),
      opts,
    );
    expect(out).toHaveLength(1);
    expect(out![0]!.subject).toBe('Гоша');
    expect(out![0]!.content).toHaveLength(100);
  });
});

describe('renderFactLine', () => {
  const base: MemoryItem = {
    id: 1,
    chatId: 1,
    scope: 'user',
    tgUserId: 10,
    subject: 'Гоша',
    content: 'серфит',
    importance: 3,
    reinforce: 0,
    source: 'passive',
    kind: 'trait',
    createdAt: 0,
    lastSeen: 0,
  };

  it('marks who, pinned and status so the rewriter knows what it holds', () => {
    expect(renderFactLine(base)).toBe('[Гоша] серфит');
    expect(renderFactLine({ ...base, source: 'explicit' })).toBe('[Гоша] 📌 серфит');
    expect(renderFactLine({ ...base, kind: 'status', content: 'во Вьетнаме' })).toBe(
      '[Гоша] (статус) во Вьетнаме',
    );
    expect(renderFactLine({ ...base, scope: 'chat', subject: '' })).toBe('[чат] серфит');
  });
});

describe('profile memory in the context block', () => {
  const base = {
    defaultCurrency: 'EUR',
    members: [],
    senderName: 'Sky',
    timezone: 'UTC',
    splidConnected: false,
  };

  it('renders cards flattened, chat card labelled, with the lag framing', () => {
    const block = buildContextBlock({
      ...base,
      profiles: [
        { subject: '', content: 'чат про сёрф\nживут на Бали' },
        { subject: 'Гоша', content: 'серфит' },
      ],
    });
    expect(block).toContain('Profile memory');
    expect(block).toContain('may LAG');
    expect(block).toContain('- Чат: чат про сёрф • живут на Бали');
    expect(block).toContain('- Гоша: серфит');
  });

  it('renders nothing for a chat with no cards', () => {
    expect(buildContextBlock({ ...base })).not.toContain('Profile memory');
  });

  it('is dropped on an expense-only scan (a card must never name the payer)', () => {
    const block = buildContextBlock({
      ...base,
      expenseOnly: true,
      profiles: [{ subject: 'Гоша', content: 'серфит' }],
    });
    expect(block).not.toContain('Profile memory');
  });
});

describe('system prompt', () => {
  it('pins the profile rules: may lag, facts win, never identity', () => {
    expect(SYSTEM_PROMPT).toContain('Profile memory');
    expect(SYSTEM_PROMPT).toContain('NEVER decides who is');
    expect(SYSTEM_PROMPT).toContain('facts always win over a card line');
  });
});
