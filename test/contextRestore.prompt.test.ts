import { describe, it, expect } from 'vitest';
import { SYSTEM_PROMPT, buildContextBlock, systemPromptFor } from '../src/llm/prompts.js';
import { buildTools, SUMMARIZE_CHAT_TOOL } from '../src/llm/tools.js';

// The bug this pins, verbatim from a real chat:
//
//   — Давай да, можешь ещё восстановить картинку из истории чата
//   — Хм, картинку из истории мне не восстановить — я не храню и не могу заново
//     открыть уже отправленные фото, доступ есть только к тексту сообщений.
//
// Two failures in one sentence. The user meant «восстанови КАРТИНУ происходящего»
// — rebuild the context out of the chat — and the bot read «картинку» as an image
// file; then it refused outright, claiming it has access only to the current text,
// while the raw log, the conversation journal and memory were all sitting right
// there unread. The chat has a full memory stack; answering «я не могу» without
// looking is the one outcome it must never produce.
//
// Routing lives in two places the model reads — the system prompt and the tool
// description — so both are pinned here.

const base = () => ({
  defaultCurrency: 'EUR',
  members: [],
  senderName: 'Андрей',
  timezone: 'Europe/Moscow',
  splidConnected: false,
});

const summarizeDescription = (): string => {
  const tool = buildTools({
    enableWebSearch: false,
    enableExpense: false,
    enableSummary: true,
  }).find((t) => 'name' in t && t.name === SUMMARIZE_CHAT_TOOL);
  return (tool as { description: string }).description;
};

describe('«восстанови картинку из истории» reads as CONTEXT, not as a file', () => {
  it('lists the phrasings people actually use for a context rebuild', () => {
    // Not «лог» — nobody says that. These are the words the ask arrives in.
    expect(SYSTEM_PROMPT).toContain('Восстанови\n   картину/картинку по чату');
    expect(SYSTEM_PROMPT).toContain('подними контекст');
    expect(SYSTEM_PROMPT).toContain('введи меня в курс');
  });

  it('spells out that «картина/картинка» there is the picture of EVENTS', () => {
    expect(SYSTEM_PROMPT).toContain('PICTURE OF EVENTS, not an image file');
    // …and that a specific photo someone points at is the exception, so the rule
    // can't be over-applied to «скинь то фото чека».
    expect(SYSTEM_PROMPT).toContain('скинь то фото чека');
  });

  it('bans the refusal that started this: no «доступа только к тексту»', () => {
    expect(SYSTEM_PROMPT).toContain('NEVER claim you have no access to this chat\'s past');
    // An empty window is a fact and may be said; «я не могу» may not.
    expect(SYSTEM_PROMPT).toMatch(/is a different\s+sentence from «я не могу»/);
  });

  it('routes the ask through all three tiers, not just one', () => {
    expect(SYSTEM_PROMPT).toMatch(/journal says which\s+sessions to look at/);
    expect(SYSTEM_PROMPT).toContain('`summarize_chat` replays what was actually said');
    expect(SYSTEM_PROMPT).toContain('`recall_memory` digs out the facts');
  });

  it('answers the literal reading honestly in the photos section', () => {
    // A photo file really is gone once the turn ends — the honest "no" stays
    // available, but it is one line plus what the log does hold.
    expect(SYSTEM_PROMPT).toContain('«Восстанови картинку из истории чата» is NOT about a picture file');
    expect(SYSTEM_PROMPT).toMatch(/when it was sent, by whom, and what was said around it/);
  });

  it('carries the same routing in the summarize_chat tool description', () => {
    const description = summarizeDescription();
    expect(description).toContain('восстанови картину/картинку по истории чата');
    expect(description).toContain('подними контекст');
    expect(description).toContain('never an image file');
    // A bare «подними контекст» names no period — the model must not stall on
    // picking dates for it.
    expect(description).toContain('leave everything null and take the recent default');
  });

  it('tells the model in the context block that the log exists and how deep', () => {
    // The other half of the same failure: with no episodes closed yet, NOTHING in
    // the context mentioned a log, so «доступ только к тексту сообщений» was an
    // accurate description of what the model could see.
    const block = buildContextBlock({
      ...base(),
      chatLog: { total: 1240, oldest: '1 августа' },
    });
    expect(block).toContain('1240 message(s) of this chat are on record');
    expect(block).toContain('oldest from 1 августа');
    expect(block).toContain('the history above is only the last few turns');
    expect(block).toMatch(/summarize_chat .*BEFORE saying you don't know/);
  });

  it('renders no log line when there is nothing to point at', () => {
    // A fresh chat, logging switched off, or a caller that passes nothing: the
    // block must stay exactly as it was — a hint about an empty log is noise, and
    // one about a log that isn't kept would be a lie.
    expect(buildContextBlock(base())).not.toContain('Chat log:');
    expect(buildContextBlock({ ...base(), chatLog: null })).not.toContain('Chat log:');
    expect(
      buildContextBlock({ ...base(), chatLog: { total: 0, oldest: null } }),
    ).not.toContain('Chat log:');
  });

  it('keeps the log line out of the silent expense-only scan', () => {
    // That run has no summarize_chat and produces no reply — the hint would be
    // paid for on every unaddressed group message and could never be acted on.
    const block = buildContextBlock({
      ...base(),
      expenseOnly: true,
      chatLog: { total: 900, oldest: '1 августа' },
    });
    expect(block).not.toContain('Chat log:');
  });

  it('holds in every persona that has the tool (tutor has neither)', () => {
    for (const mode of ['secretary', 'assistant', 'funny', 'dota'] as const) {
      expect(systemPromptFor(mode)).toContain('PICTURE OF EVENTS, not an image file');
    }
    // A custom persona is a TONE override on the same behaviour rules.
    expect(systemPromptFor('custom', 'говори как пират')).toContain(
      'PICTURE OF EVENTS, not an image file',
    );
    // Tutor is a different prompt with no chat log to read — nothing to route.
    expect(systemPromptFor('tutor')).not.toContain('PICTURE OF EVENTS');
  });
});
