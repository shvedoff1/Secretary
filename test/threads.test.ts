import { describe, it, expect } from 'vitest';
import { logRefs, threadIdOf, topicNameFrom } from '../src/bot/threads.js';
import { messageLink } from '../src/util/telegramLink.js';
import { forumTopicsLine, renderLines, resolveThread } from '../src/summary/transcript.js';
import type { LoggedMessage } from '../src/db/repos/chatLog.repo.js';

// Forum topics («треды») and links back to messages — the pure parts.

describe('threadIdOf / logRefs', () => {
  it('reads the topic only from a real topic message', () => {
    expect(threadIdOf({ message_id: 5, is_topic_message: true, message_thread_id: 12 })).toBe(12);
    // A plain reply thread in a non-forum group also carries message_thread_id —
    // without is_topic_message it is NOT a forum topic.
    expect(threadIdOf({ message_id: 5, message_thread_id: 3 })).toBeNull();
    expect(threadIdOf(undefined)).toBeNull();
  });

  it('pairs the topic with the message id for the log', () => {
    expect(logRefs({ message_id: 9, is_topic_message: true, message_thread_id: 4 })).toEqual({
      threadId: 4,
      messageId: 9,
    });
    expect(logRefs(undefined)).toEqual({ threadId: null, messageId: null });
  });
});

describe('messageLink', () => {
  it('builds a private t.me/c link for supergroups, thread-scoped inside a topic', () => {
    expect(messageLink(-1001234567890, 77)).toBe('https://t.me/c/1234567890/77');
    expect(messageLink(-1001234567890, 77, 12)).toBe('https://t.me/c/1234567890/12/77');
  });

  it('has no link where Telegram has none — never a fabricated 404', () => {
    expect(messageLink(-4567, 77)).toBeNull(); // basic group
    expect(messageLink(42, 77)).toBeNull(); // DM
    expect(messageLink(-1001234567890, null)).toBeNull();
  });
});

describe('topicNameFrom', () => {
  it('learns a name from the creation and rename service messages', () => {
    expect(
      topicNameFrom({
        message_id: 12,
        message_thread_id: 12,
        forum_topic_created: { name: 'Баги', icon_color: 0 },
      }),
    ).toEqual({ threadId: 12, name: 'Баги' });
    expect(
      topicNameFrom({ message_id: 30, message_thread_id: 12, forum_topic_edited: { name: 'QA' } }),
    ).toEqual({ threadId: 12, name: 'QA' });
  });

  it('learns a pre-existing topic from the root reference a topic message carries', () => {
    expect(
      topicNameFrom({
        message_id: 50,
        is_topic_message: true,
        message_thread_id: 7,
        reply_to_message: { forum_topic_created: { name: 'Релиз', icon_color: 0 } },
      }),
    ).toEqual({ threadId: 7, name: 'Релиз' });
  });

  it('learns nothing from an ordinary message', () => {
    expect(topicNameFrom({ message_id: 1 })).toBeNull();
  });
});

const TOPICS = [
  { threadId: 12, name: 'QA' },
  { threadId: 40, name: 'Релиз 2.0' },
  { threadId: 41, name: 'Релиз 2.1' },
];

describe('resolveThread', () => {
  it('no thread => the whole chat', () => {
    expect(resolveThread(null, TOPICS, 12)).toEqual({ ok: true, threadId: null, label: null });
  });

  it('«этот тред» => the topic the message is in; General outside topics', () => {
    expect(resolveThread('этот тред', TOPICS, 12)).toEqual({ ok: true, threadId: 12, label: 'QA' });
    expect(resolveThread('this', TOPICS, null)).toEqual({ ok: true, threadId: 0, label: 'General' });
  });

  it('matches names forgivingly: case, «тред X», #tag, unique containment, id', () => {
    expect(resolveThread('qa', TOPICS, null)).toMatchObject({ threadId: 12 });
    expect(resolveThread('тред QA', TOPICS, null)).toMatchObject({ threadId: 12 });
    expect(resolveThread('#QA', TOPICS, null)).toMatchObject({ threadId: 12 });
    expect(resolveThread('2.1', TOPICS, null)).toMatchObject({ threadId: 41 });
    expect(resolveThread('40', TOPICS, null)).toMatchObject({ threadId: 40, label: 'Релиз 2.0' });
    expect(resolveThread('general', TOPICS, 12)).toMatchObject({ threadId: 0 });
  });

  it('an ambiguous or unknown name is an error, never a guess', () => {
    const amb = resolveThread('релиз', TOPICS, null);
    expect(amb.ok).toBe(false);
    if (!amb.ok) expect(amb.error).toContain('ambiguous');
    const none = resolveThread('маркетинг', TOPICS, null);
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.error).toContain('«QA» (id 12)');
  });
});

function msg(over: Partial<LoggedMessage>): LoggedMessage {
  return {
    id: 1,
    role: 'user',
    kind: 'text',
    tgUserId: 7,
    senderName: 'Петя',
    content: 'текст',
    createdAt: Date.UTC(2026, 9, 9, 9, 0),
    threadId: null,
    messageId: null,
    mediaFileId: null,
    ...over,
  };
}

describe('transcript lines in a work chat', () => {
  const CHAT = -1001234567890;

  it('keeps the plain shape when nothing extra is asked for', () => {
    const out = renderLines([msg({ kind: 'voice', content: 'не грузится', messageId: 5 })], 'UTC');
    expect(out).toContain('[09:00] Петя (голосовое): не грузится');
    expect(out).not.toContain('t.me');
  });

  it('tags topics, links voice/media lines and marks media refs', () => {
    const out = renderLines(
      [
        msg({ id: 1, content: 'привет', messageId: 4, threadId: 12 }),
        msg({ id: 2, kind: 'voice', content: 'корзина падает', messageId: 5, threadId: 12 }),
        msg({ id: 3, kind: 'photo', content: '(фото без подписи)', messageId: 6, mediaFileId: 'F' }),
      ],
      { tz: 'UTC', chatId: CHAT, topicNames: new Map([[12, 'QA']]), links: 'media' },
    );
    expect(out).toContain('[09:00] {QA} Петя: привет\n');
    expect(out).toContain(
      '{QA} Петя (голосовое): корзина падает https://t.me/c/1234567890/12/5',
    );
    expect(out).toContain(
      '{General} Петя (фото): (фото без подписи) [медиа #3] https://t.me/c/1234567890/6',
    );
  });

  it("links every user line for a focused ask, never the bot's own posts", () => {
    const out = renderLines(
      [msg({ content: 'баг в оплате', messageId: 8 }), msg({ role: 'assistant', content: 'ок', messageId: 9 })],
      { tz: 'UTC', chatId: CHAT, links: 'all' },
    );
    expect(out).toContain('баг в оплате https://t.me/c/1234567890/8');
    expect(out).toContain('Бот: ок');
    expect(out).not.toContain('/9');
  });
});

describe('forumTopicsLine', () => {
  it('lists topics and names the current one', () => {
    expect(forumTopicsLine(TOPICS.slice(0, 1), 12)).toBe(
      'Forum topics (threads; summarize_chat.thread scopes a recap to one): «QA» (id 12). This message is in: «QA» (id 12).',
    );
  });

  it('is absent for a chat without topics', () => {
    expect(forumTopicsLine([], null)).toBeNull();
  });
});
