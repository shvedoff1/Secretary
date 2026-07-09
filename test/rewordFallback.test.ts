import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'grammy';
import type { ExpenseDraft } from '../src/core/types.js';

// Reword pulls in a lot of repos; mock the ones it actually calls on the
// text-fallback path and stub the assistant so we control what it "decides".
vi.mock('../src/llm/assistant.js', () => ({ runAssistant: vi.fn() }));
vi.mock('../src/db/repos/pending.repo.js', () => ({
  getPending: vi.fn(),
  updateDraft: vi.fn(),
}));
vi.mock('../src/db/repos/chatConfig.repo.js', () => ({
  getChatConfig: vi.fn(() => ({
    provider_group_id: 'g1',
    provider_name: 'splid',
    default_currency: 'USD',
  })),
  setChatTitle: vi.fn(),
}));
vi.mock('../src/core/registry.js', () => ({
  getProvider: vi.fn(() => ({ listMembers: vi.fn(async () => []) })),
}));
vi.mock('../src/db/repos/chatSettings.repo.js', () => ({
  getTimezone: vi.fn(() => 'UTC'),
  setTimezone: vi.fn(),
}));
vi.mock('../src/util/richMessage.js', () => ({ sendRichMarkdown: vi.fn() }));
vi.mock('../src/bot/flows/typing.js', () => ({
  startTyping: vi.fn(() => ({ stop: vi.fn() })),
}));

import { rewordPending } from '../src/bot/flows/assist.js';
import { runAssistant } from '../src/llm/assistant.js';
import { getPending } from '../src/db/repos/pending.repo.js';
import { sendRichMarkdown } from '../src/util/richMessage.js';

const mockAssistant = vi.mocked(runAssistant);
const mockGetPending = vi.mocked(getPending);
const mockSend = vi.mocked(sendRichMarkdown);

const draft: ExpenseDraft = {
  title: 'кофе',
  amountMinor: 50000,
  currency: 'USD',
  payers: [],
  profiteers: [],
  unresolved: [],
  notes: null,
  confidence: 0.9,
} as unknown as ExpenseDraft;

function ctx(text: string): Context {
  return {
    chat: { id: 1, type: 'group' },
    from: { id: 2 },
    message: { message_id: 77, text },
    react: vi.fn(),
    reply: vi.fn(),
    api: { sendMessage: vi.fn() },
  } as unknown as Context;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  mockGetPending.mockReturnValue({ status: 'awaiting', draft } as never);
});

describe('rewordPending graceful fallback', () => {
  it('answers a non-correction reply instead of dead-ending with "Не понял правку"', async () => {
    // The reply to the preview turned out to be a different request; the assistant
    // answered it (e.g. a surf forecast) rather than returning an expense.
    mockAssistant.mockResolvedValue({ kind: 'text', text: '🌊 Волны 1.2м в Чангу' } as never);
    const c = ctx('а какие волны в Чангу?');

    await rewordPending(c, 'pending-1', 42, 'а какие волны в Чангу?');

    // The model's answer is delivered to the chat...
    expect(mockSend).toHaveBeenCalledOnce();
    expect(mockSend.mock.calls[0]?.[2]).toContain('🌊 Волны 1.2м в Чангу');
    // ...and no "не понял правку" dead-end reply is sent.
    expect(c.reply).not.toHaveBeenCalled();
  });
});
