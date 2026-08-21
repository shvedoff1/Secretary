import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { forwardOrigin, isForwarded, passiveLearningAllowed } from '../src/bot/forwarded.js';

// Forwarded vs. written-here. The origin label goes to the model (so it never
// attributes a forward to the sender, and a chat rule can key on it), and the
// passive-learning gate keeps a stranger's words out of the chat's memory/lexicon.

function msg(over: Record<string, unknown>) {
  return { message_id: 1, text: 'привет', ...over } as never;
}

beforeEach(() => {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  delete process.env.LEARN_FROM_FORWARDS;
});
afterEach(() => {
  delete process.env.LEARN_FROM_FORWARDS;
});

describe('isForwarded', () => {
  it('is false for a message written in the chat', () => {
    expect(isForwarded(msg({}))).toBe(false);
    expect(isForwarded(undefined)).toBe(false);
    expect(forwardOrigin(msg({}))).toBeNull();
  });

  it('is true for every shape Telegram uses', () => {
    expect(isForwarded(msg({ forward_origin: { type: 'hidden_user', sender_user_name: 'X' } }))).toBe(true);
    expect(isForwarded(msg({ forward_from: { first_name: 'Вася' } }))).toBe(true);
    expect(isForwarded(msg({ forward_from_chat: { title: 'Канал' } }))).toBe(true);
    expect(isForwarded(msg({ forward_sender_name: 'Аноним' }))).toBe(true);
    expect(isForwarded(msg({ forward_date: 1700000000 }))).toBe(true);
  });
});

describe('forwardOrigin label', () => {
  it('names a person', () => {
    const from = { first_name: 'Вася', last_name: 'Пупкин', username: 'vasya' };
    expect(forwardOrigin(msg({ forward_origin: { type: 'user', sender_user: from } }))).toBe(
      'Вася Пупкин',
    );
    // Falls back to the @username when the name is missing.
    expect(
      forwardOrigin(msg({ forward_origin: { type: 'user', sender_user: { username: 'vasya' } } })),
    ).toBe('@vasya');
  });

  it('names a channel and a group chat', () => {
    expect(
      forwardOrigin(msg({ forward_origin: { type: 'channel', chat: { title: 'Дуров пишет' } } })),
    ).toBe('канал «Дуров пишет»');
    expect(
      forwardOrigin(msg({ forward_origin: { type: 'chat', sender_chat: { title: 'Соседи' } } })),
    ).toBe('чат «Соседи»');
  });

  it('handles a hidden sender (privacy settings)', () => {
    expect(
      forwardOrigin(msg({ forward_origin: { type: 'hidden_user', sender_user_name: 'Аноним' } })),
    ).toBe('Аноним');
    expect(forwardOrigin(msg({ forward_origin: { type: 'hidden_user', sender_user_name: '' } }))).toBe(
      'скрытый отправитель',
    );
  });

  it('reads the legacy pre-Bot-API-7 fields too', () => {
    expect(forwardOrigin(msg({ forward_from: { first_name: 'Петя' } }))).toBe('Петя');
    expect(forwardOrigin(msg({ forward_from_chat: { title: 'Новости' } }))).toBe('канал «Новости»');
    expect(forwardOrigin(msg({ forward_sender_name: 'Аноним' }))).toBe('Аноним');
    // Forwarded, but Telegram told us nothing about the source.
    expect(forwardOrigin(msg({ forward_date: 1700000000 }))).toBe('источник неизвестен');
  });
});

describe('passive learning gate', () => {
  it('learns from a message written in the chat', () => {
    expect(passiveLearningAllowed(msg({}))).toBe(true);
  });

  it('skips a forwarded message by default', () => {
    expect(passiveLearningAllowed(msg({ forward_from: { first_name: 'Вася' } }))).toBe(false);
  });

  it('can be switched back on with LEARN_FROM_FORWARDS', async () => {
    // The config is a module-level singleton, so the flag has to be set before the
    // module tree is (re)loaded.
    process.env.LEARN_FROM_FORWARDS = 'true';
    vi.resetModules();
    const fresh = await import('../src/bot/forwarded.js');
    expect(fresh.passiveLearningAllowed(msg({ forward_from: { first_name: 'Вася' } }))).toBe(true);
  });
});
