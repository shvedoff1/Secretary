import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'grammy';

vi.mock('../src/bot/flows/assist.js', () => ({ senderName: () => 'Аня' }));
vi.mock('../src/bot/chatLog.js', () => ({ recordChatLog: vi.fn() }));

import { onVideo, formatDuration } from '../src/bot/handlers/onVideo.js';
import { recordChatLog } from '../src/bot/chatLog.js';

// Videos are LOGGED as references (thumbnail file_id + link), never processed.

function ctx(message: Record<string, unknown>) {
  const reply = vi.fn();
  return {
    ctx: {
      message: { message_id: 50, ...message },
      chat: { id: -1001234567890, type: 'supergroup' },
      from: { id: 7, first_name: 'Аня' },
      reply,
    } as unknown as Context,
    reply,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('onVideo', () => {
  it('logs a video with its caption, length, topic and thumbnail — and says nothing', async () => {
    const { ctx: c, reply } = ctx({
      video: { file_id: 'V', duration: 75, thumbnail: { file_id: 'TH' } },
      caption: 'вот как падает экран оплаты',
      is_topic_message: true,
      message_thread_id: 12,
    });
    await onVideo(c);
    expect(recordChatLog).toHaveBeenCalledWith({
      chatId: -1001234567890,
      role: 'user',
      kind: 'video',
      tgUserId: 7,
      senderName: 'Аня',
      content: '(видео, 1:15) вот как падает экран оплаты',
      forwarded: false,
      threadId: 12,
      messageId: 50,
      mediaFileId: 'TH',
    });
    expect(reply).not.toHaveBeenCalled();
  });

  it('logs a video note («кружок») even without a thumbnail', async () => {
    const { ctx: c } = ctx({ video_note: { file_id: 'N', duration: 9 } });
    await onVideo(c);
    expect(recordChatLog).toHaveBeenCalledWith(
      expect.objectContaining({ content: '(кружок, 0:09)', mediaFileId: null, threadId: null }),
    );
  });

  it('formats durations', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(605)).toBe('10:05');
  });
});
