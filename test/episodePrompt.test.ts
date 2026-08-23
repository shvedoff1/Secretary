import { describe, it, expect } from 'vitest';
import {
  SYSTEM_PROMPT,
  buildContextBlock,
  buildTutorContextBlock,
} from '../src/llm/prompts.js';

// The conversation journal in the context block: condensed notes of past
// sessions, labeled as notes (never verbatim), with the deep tier advertised.

const base = {
  defaultCurrency: 'EUR',
  members: [],
  senderName: 'Sky',
  timezone: 'UTC',
  splidConnected: false,
};

describe('conversation journal in the context block', () => {
  it('renders journal lines with the not-verbatim framing and the hidden count', () => {
    const block = buildContextBlock({
      ...base,
      episodes: ['[21 августа (2026-08-21)] [темы: серф] Гоша ищет доску'],
      episodeTotal: 7,
    });
    expect(block).toContain('Conversation journal');
    expect(block).toContain('NOT verbatim');
    expect(block).toContain('Гоша ищет доску');
    // 6 older sessions hidden → recall reaches them.
    expect(block).toContain('6 older session(s)');
    expect(block).toContain('recall_memory');
  });

  it('renders nothing journal-related for a chat with no episodes', () => {
    expect(buildContextBlock({ ...base })).not.toContain('Conversation journal');
  });

  it('is dropped entirely on an expense-only scan', () => {
    const block = buildContextBlock({
      ...base,
      expenseOnly: true,
      episodes: ['[21 августа] что-то было'],
      episodeTotal: 1,
      memoryTopics: ['серф'],
    });
    expect(block).not.toContain('Conversation journal');
    expect(block).not.toContain('Topics with stored material');
  });

  it('adds the topic index to the memory depth hint', () => {
    const block = buildContextBlock({
      ...base,
      memoryChat: [{ content: 'факт' }],
      memoryTotal: 40,
      memoryTopics: ['Гоша', 'серф', 'поездка'],
    });
    expect(block).toContain('Topics with stored material: Гоша, серф, поездка.');
  });

  it('keeps the depth hint clean when no topics are known', () => {
    const block = buildContextBlock({
      ...base,
      memoryChat: [{ content: 'факт' }],
      memoryTotal: 40,
    });
    expect(block).toContain('Memory store: 40 facts total');
    expect(block).not.toContain('Topics with stored material');
  });

  it('reaches the tutor context block too', () => {
    const block = buildTutorContextBlock({
      senderName: 'ученик',
      timezone: 'UTC',
      episodes: ['[вчера] разбирали квадратные уравнения'],
      episodeTotal: 1,
    });
    expect(block).toContain('квадратные уравнения');
  });
});

describe('system prompt', () => {
  it('explains the journal: notes, recall for older entries, summarize_chat for verbatim', () => {
    expect(SYSTEM_PROMPT).toContain('Conversation journal');
    expect(SYSTEM_PROMPT).toContain('notes, not transcripts');
    expect(SYSTEM_PROMPT).toContain('summarize_chat');
  });
});
