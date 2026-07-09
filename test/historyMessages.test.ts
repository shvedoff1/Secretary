import { describe, it, expect } from 'vitest';
import { historyToMessages } from '../src/llm/assistant.js';
import type { Turn } from '../src/db/repos/conversation.repo.js';

function turn(role: 'user' | 'assistant', content: string, senderName: string | null = null): Turn {
  return { role, content, senderName, tgUserId: role === 'user' ? 1 : null, createdAt: 0 };
}

describe('historyToMessages', () => {
  it('passes clean alternating history through unchanged', () => {
    const h = [turn('user', 'привет'), turn('assistant', 'здорова'), turn('user', 'как дела')];
    expect(historyToMessages(h)).toEqual([
      { role: 'user', content: 'привет' },
      { role: 'assistant', content: 'здорова' },
      { role: 'user', content: 'как дела' },
    ]);
  });

  it('prefixes user turns with the author name so speakers stay distinct', () => {
    const h = [
      turn('user', 'погнали баклажанить', 'Школяр'),
      turn('assistant', 'го'),
      turn('user', 'йоу братуха', 'skyler white yo'),
    ];
    expect(historyToMessages(h)).toEqual([
      { role: 'user', content: 'Школяр: погнали баклажанить' },
      { role: 'assistant', content: 'го' },
      { role: 'user', content: 'skyler white yo: йоу братуха' },
    ]);
  });

  it('keeps both authors when folding two back-to-back user turns', () => {
    // Two people speak before the bot replies — the turns fold into one user
    // message, but each keeps its own "Name:" prefix so they stay attributable.
    const h = [
      turn('user', 'я плачу', 'Школяр'),
      turn('user', 'а я нет', 'Скай'),
    ];
    expect(historyToMessages(h)).toEqual([
      { role: 'user', content: 'Школяр: я плачу\nСкай: а я нет' },
    ]);
  });

  it('drops leading assistant turns so the prefix opens on a user turn', () => {
    // A sliding-window / age cut can keep an assistant reply whose user turn was
    // dropped — the API rejects a conversation that starts with assistant.
    const h = [turn('assistant', 'обрезанный ответ'), turn('user', 'вопрос'), turn('assistant', 'ответ')];
    expect(historyToMessages(h)).toEqual([
      { role: 'user', content: 'вопрос' },
      { role: 'assistant', content: 'ответ' },
    ]);
  });

  it('merges back-to-back assistant turns (lone scheduled posts) into one', () => {
    // Two recurring tasks can post with no user message between them; the API
    // forbids two assistant messages in a row.
    const h = [
      turn('user', 'йо'),
      turn('assistant', '⏰ прогноз по Бали\nволны 1.2м'),
      turn('assistant', '⏰ сводка трат\nсегодня 0'),
      turn('user', 'обнови прогноз'),
    ];
    expect(historyToMessages(h)).toEqual([
      { role: 'user', content: 'йо' },
      { role: 'assistant', content: '⏰ прогноз по Бали\nволны 1.2м\n⏰ сводка трат\nсегодня 0' },
      { role: 'user', content: 'обнови прогноз' },
    ]);
  });

  it('retains a scheduled post that sits mid-window (the reported scenario)', () => {
    // A recurring forecast is posted after prior chatter, then a follow-up asks to
    // update it — the post is now in history for the assistant to build on.
    const h = [
      turn('user', 'что по волнам'),
      turn('assistant', 'смотрю'),
      turn('assistant', '⏰ прогноз по Бали\nволны 1.2м'),
      turn('user', 'обнови'),
    ];
    expect(historyToMessages(h)).toEqual([
      { role: 'user', content: 'что по волнам' },
      { role: 'assistant', content: 'смотрю\n⏰ прогноз по Бали\nволны 1.2м' },
      { role: 'user', content: 'обнови' },
    ]);
  });

  it('returns an empty prefix for empty or assistant-only history', () => {
    expect(historyToMessages([])).toEqual([]);
    // A lone leading assistant post with no user turn before it can't open a valid
    // conversation, so it's dropped; the current user message opens the request and
    // a direct reply still carries the post via the quoted-context block in onMessage.
    expect(historyToMessages([turn('assistant', '⏰ прогноз')])).toEqual([]);
  });
});
