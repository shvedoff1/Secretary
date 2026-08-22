import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'grammy';

// onMessage now consults the config (the LEARN_FROM_FORWARDS gate), which is
// validated on first read — give it a valid environment.
process.env.BOT_TOKEN = 'x';
process.env.ANTHROPIC_API_KEY = 'x';
process.env.ADMIN_TELEGRAM_ID = '1';
process.env.DATABASE_PATH = ':memory:';

vi.mock('../src/bot/triggers.js', () => ({
  routeMessage: vi.fn(),
  isAddressed: vi.fn(),
  addressesBotByName: vi.fn(),
  isFreshBotRequest: vi.fn(),
}));
vi.mock('../src/bot/flows/assist.js', () => ({
  runAndRespond: vi.fn(),
  rewordPending: vi.fn(),
  senderName: () => 'Tester',
}));
vi.mock('../src/bot/flows/lexicon.js', () => ({
  learnFromMessage: vi.fn(() => Promise.resolve()),
}));
vi.mock('../src/bot/flows/memory.js', () => ({
  learnMemoryFromMessage: vi.fn(() => Promise.resolve()),
}));
vi.mock('../src/bot/flows/chime.js', () => ({
  recordChatMessage: vi.fn(),
  armChime: vi.fn(),
}));
vi.mock('../src/bot/editTargets.js', () => ({
  getEditTarget: vi.fn(() => undefined),
}));
vi.mock('../src/bot/handlers/onPhoto.js', () => ({
  handleReceiptPhoto: vi.fn(),
}));
vi.mock('../src/bot/forwardBuffer.js', () => ({
  bufferForward: vi.fn(() => true),
  isForwardBufferEnabled: vi.fn(() => true),
  FORWARD_MARK: '🫡',
}));
vi.mock('../src/db/repos/chatSettings.repo.js', () => ({
  getChatMode: vi.fn(() => 'secretary'),
}));
vi.mock('../src/bot/chatLog.js', () => ({
  recordChatLog: vi.fn(),
}));

import { onMessage } from '../src/bot/handlers/onMessage.js';
import {
  routeMessage,
  addressesBotByName,
  isAddressed,
  isFreshBotRequest,
} from '../src/bot/triggers.js';
import { runAndRespond, rewordPending } from '../src/bot/flows/assist.js';
import { learnFromMessage } from '../src/bot/flows/lexicon.js';
import { learnMemoryFromMessage } from '../src/bot/flows/memory.js';
import { handleReceiptPhoto } from '../src/bot/handlers/onPhoto.js';
import { recordChatMessage, armChime } from '../src/bot/flows/chime.js';
import { getEditTarget } from '../src/bot/editTargets.js';
import { getChatMode } from '../src/db/repos/chatSettings.repo.js';
import { bufferForward, isForwardBufferEnabled } from '../src/bot/forwardBuffer.js';
import { recordChatLog } from '../src/bot/chatLog.js';

const mockRoute = vi.mocked(routeMessage);
const mockByName = vi.mocked(addressesBotByName);
const mockAddressed = vi.mocked(isAddressed);
const mockFresh = vi.mocked(isFreshBotRequest);
const mockRun = vi.mocked(runAndRespond);
const mockReword = vi.mocked(rewordPending);
const mockLearn = vi.mocked(learnFromMessage);
const mockLearnMemory = vi.mocked(learnMemoryFromMessage);
const mockPhoto = vi.mocked(handleReceiptPhoto);
const mockRecord = vi.mocked(recordChatMessage);
const mockChime = vi.mocked(armChime);
const mockEditTarget = vi.mocked(getEditTarget);
const mockMode = vi.mocked(getChatMode);
const mockLog = vi.mocked(recordChatLog);

function ctx(text: string): Context {
  return {
    message: { text },
    chat: { id: 1, type: 'group' },
    from: { id: 2 },
  } as unknown as Context;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockByName.mockReturnValue(false);
  mockAddressed.mockReturnValue(false);
  mockFresh.mockReturnValue(false);
  mockEditTarget.mockReturnValue(undefined);
  mockMode.mockReturnValue('secretary');
});

function replyToPreview(text: string): Context {
  return {
    message: { text, reply_to_message: { message_id: 42, from: { id: 999 } } },
    chat: { id: 1, type: 'group' },
    from: { id: 2 },
  } as unknown as Context;
}

describe('onMessage reply to an expense preview', () => {
  it('rewords a bare correction reply ("это Миша")', async () => {
    mockEditTarget.mockReturnValue('pending-1');
    mockFresh.mockReturnValue(false); // not a fresh ask — an actual correction

    await onMessage(replyToPreview('это Миша'));

    expect(mockReword).toHaveBeenCalledOnce();
    expect(mockReword.mock.calls[0]?.slice(1)).toEqual(['pending-1', 42, 'это Миша']);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('does NOT reword when the reply is a fresh request to the bot', async () => {
    // Regression: replying to a stale preview with "@bot обнови прогноз по Бали" used
    // to be force-parsed as an expense edit and die with "Не понял правку". It must
    // instead reach the assistant as a normal request.
    mockEditTarget.mockReturnValue('pending-1');
    mockFresh.mockReturnValue(true);
    mockRoute.mockReturnValue('process');

    await onMessage(replyToPreview('@skyler_white_yo_bot обнови прогноз по Бали'));

    expect(mockReword).not.toHaveBeenCalled();
    expect(mockRun).toHaveBeenCalledOnce();
    expect(mockRun.mock.calls[0]?.[1]).toMatchObject({ addressed: true });
  });

  it('does not touch the reword flow when there is no pending preview', async () => {
    mockEditTarget.mockReturnValue(undefined);
    mockRoute.mockReturnValue('process');

    await onMessage(replyToPreview('просто ответ'));

    expect(mockReword).not.toHaveBeenCalled();
    expect(mockRun).toHaveBeenCalledOnce();
  });
});

describe('onMessage by-name addressing', () => {
  it('answers a by-name question that routing would otherwise ignore', async () => {
    mockRoute.mockReturnValue('ignore');
    mockByName.mockReturnValue(true);

    await onMessage(ctx('Скай, какая погода?'));

    expect(mockRun).toHaveBeenCalledOnce();
    expect(mockRun.mock.calls[0]?.[1]).toMatchObject({ addressed: true });
  });

  it('stays silent on plain group chatter (no name, not an expense)', async () => {
    mockRoute.mockReturnValue('ignore');
    mockByName.mockReturnValue(false);

    await onMessage(ctx('всем привет'));

    expect(mockRun).not.toHaveBeenCalled();
    // Ignored chatter still records context and starts the silence countdown.
    expect(mockRecord).toHaveBeenCalledWith(1, 'Tester', 'всем привет');
    expect(mockChime).toHaveBeenCalledOnce();
  });

  it('does not arm a chime when the message is for the bot', async () => {
    mockRoute.mockReturnValue('process');

    await onMessage(ctx('Скай, посчитай'));

    expect(mockRun).toHaveBeenCalledOnce();
    expect(mockChime).not.toHaveBeenCalled();
  });

  it('feeds every message to lexicon learning, even ignored chatter', async () => {
    mockRoute.mockReturnValue('ignore');
    mockByName.mockReturnValue(false);

    await onMessage(ctx('тип здарова братик'));

    expect(mockRun).not.toHaveBeenCalled();
    expect(mockLearn).toHaveBeenCalledWith(1, 'тип здарова братик');
  });

  it('keeps an unaddressed expense as a silent auto-expense scan', async () => {
    mockRoute.mockReturnValue('auto-expense');
    mockByName.mockReturnValue(false);

    await onMessage(ctx('потратил 500 на такси'));

    expect(mockRun).toHaveBeenCalledOnce();
    expect(mockRun.mock.calls[0]?.[1]).toMatchObject({ addressed: false });
  });
});

describe('onMessage reply context', () => {
  it('recovers a replied-to voice note transcript as context for the assistant', async () => {
    const { setTranscript } = await import('../src/bot/transcriptCache.js');
    setTranscript(1, 555, 'Иван проспонсировал поход. 2000 Айдейр');
    mockRoute.mockReturnValue('process');

    const c = {
      message: {
        text: 'это была трата',
        reply_to_message: { message_id: 555 }, // a voice note: no text/caption
      },
      chat: { id: 1, type: 'group' },
      from: { id: 2 },
    } as unknown as Context;

    await onMessage(c);

    expect(mockRun).toHaveBeenCalledOnce();
    const args = mockRun.mock.calls[0]?.[1] as { userContent: string };
    expect(args.userContent).toContain('Иван проспонсировал поход. 2000 Айдейр');
    expect(args.userContent).toContain('это была трата');
  });

  it('names the author of the quoted message so the assistant attributes it right', async () => {
    mockRoute.mockReturnValue('process');
    const c = {
      message: {
        text: 'запомни, это трата',
        reply_to_message: {
          message_id: 77,
          text: 'закинул 500 за бензин',
          from: { first_name: 'Школяр' },
        },
      },
      chat: { id: 1, type: 'group' },
      from: { id: 2 },
    } as unknown as Context;

    await onMessage(c);

    const args = mockRun.mock.calls[0]?.[1] as { userContent: string };
    expect(args.userContent).toContain('В ответ на сообщение от Школяр');
    expect(args.userContent).toContain('закинул 500 за бензин');
  });

  it('passes plain text (no quote block) when replying to a voice we never transcribed', async () => {
    mockRoute.mockReturnValue('process');
    const c = {
      message: {
        text: 'это была трата',
        reply_to_message: { message_id: 999 }, // unknown id → no cached transcript
      },
      chat: { id: 1, type: 'group' },
      from: { id: 2 },
    } as unknown as Context;

    await onMessage(c);

    const args = mockRun.mock.calls[0]?.[1] as { userContent: string };
    expect(args.userContent).toBe('это была трата');
  });
});

describe('onMessage reply to a photo', () => {
  it('keeps the photo caption when the reply pings the bot («это трата»)', async () => {
    mockAddressed.mockReturnValue(true);
    const photo = [{ file_id: 'big' }];
    const c = {
      message: {
        text: '@skyler_white_yo_bot это трата',
        reply_to_message: { message_id: 42, photo, caption: 'Скай, на меня Ивана и Антона' },
      },
      chat: { id: 1, type: 'group' },
      from: { id: 2 },
    } as unknown as Context;

    await onMessage(c);

    expect(mockPhoto).toHaveBeenCalledOnce();
    const [, photos, caption, addressed] = mockPhoto.mock.calls[0]!;
    expect(photos).toBe(photo);
    // Both the original instruction and the new ping reach the assistant.
    expect(caption).toContain('Скай, на меня Ивана и Антона');
    expect(caption).toContain('@skyler_white_yo_bot это трата');
    expect(addressed).toBe(true);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('passes just the reply text when the photo had no caption', async () => {
    mockAddressed.mockReturnValue(true);
    const photo = [{ file_id: 'big' }];
    const c = {
      message: {
        text: '@skyler_white_yo_bot это трата',
        reply_to_message: { message_id: 42, photo }, // no caption
      },
      chat: { id: 1, type: 'group' },
      from: { id: 2 },
    } as unknown as Context;

    await onMessage(c);

    expect(mockPhoto).toHaveBeenCalledOnce();
    expect(mockPhoto.mock.calls[0]![2]).toBe('@skyler_white_yo_bot это трата');
  });

  it('does not divert to the photo path when the reply does not address the bot', async () => {
    mockAddressed.mockReturnValue(false);
    mockRoute.mockReturnValue('process');
    const photo = [{ file_id: 'big' }];
    const c = {
      message: {
        text: 'ага',
        reply_to_message: { message_id: 42, photo, caption: 'на меня Ивана и Антона' },
      },
      chat: { id: 1, type: 'group' },
      from: { id: 2 },
    } as unknown as Context;

    await onMessage(c);

    expect(mockPhoto).not.toHaveBeenCalled();
  });
});

describe('onMessage in tutor mode', () => {
  it('does not feed messages to lexicon learning (the tutor never speaks slang)', async () => {
    mockMode.mockReturnValue('tutor');
    mockRoute.mockReturnValue('process');

    await onMessage(ctx('реши задачу про скорость'));

    expect(mockLearn).not.toHaveBeenCalled();
    expect(mockRun).toHaveBeenCalledOnce();
  });

  it('never arms a spontaneous chime on ignored chatter', async () => {
    mockMode.mockReturnValue('tutor');
    mockRoute.mockReturnValue('ignore');

    await onMessage(ctx('просто болтовня'));

    expect(mockChime).not.toHaveBeenCalled();
  });

  it('secretary mode still learns lexicon and arms the chime (regression guard)', async () => {
    mockMode.mockReturnValue('secretary');
    mockRoute.mockReturnValue('ignore');

    await onMessage(ctx('просто болтовня'));

    expect(mockLearn).toHaveBeenCalledOnce();
    expect(mockChime).toHaveBeenCalledOnce();
  });
});


// Forwarded messages are someone else's words: passive learning (slang + memory)
// must not read them, and instead of being answered (or routed as expenses) one
// by one they join the per-chat forward batch, marked with the 🫡 reaction. The
// batch is consumed later — by an addressed ask or a tap on the mark.
function forwardedCtx(text: string): Context {
  const react = vi.fn(async () => {});
  const c = {
    message: {
      message_id: 77,
      text,
      forward_origin: { type: 'channel', chat: { title: 'Новости' } },
    },
    chat: { id: 1, type: 'group' },
    from: { id: 2 },
    react,
  } as unknown as Context;
  return c;
}

describe('forwarded messages go to the batch', () => {
  it('learns slang and memory from a message written in the chat', async () => {
    mockRoute.mockReturnValue('ignore');
    await onMessage(ctx('да ну ты гонишь'));

    expect(mockLearn).toHaveBeenCalledOnce();
    expect(mockLearnMemory).toHaveBeenCalledOnce();
  });

  it('buffers a forward with its origin and marks it, learning nothing', async () => {
    mockRoute.mockReturnValue('ignore');
    const c = forwardedCtx('В Москве открыли новый мост');
    await onMessage(c);

    expect(mockLearn).not.toHaveBeenCalled();
    expect(mockLearnMemory).not.toHaveBeenCalled();
    expect(vi.mocked(bufferForward)).toHaveBeenCalledWith(1, {
      messageId: 77,
      origin: 'канал «Новости»',
      kind: 'text',
      text: 'В Москве открыли новый мост',
    });
    expect((c as unknown as { react: unknown }).react).toHaveBeenCalledWith('🫡');
    // Buffered means handled: no per-message reply, no auto-expense scan, no chime.
    expect(mockRun).not.toHaveBeenCalled();
    expect(mockRoute).not.toHaveBeenCalled();
    expect(mockChime).not.toHaveBeenCalled();
    // The chatter buffer still records it (chat activity is chat activity).
    expect(mockRecord).toHaveBeenCalledOnce();
  });

  it('does NOT reply to a forward even when its text happens to address the bot', async () => {
    // The text was written by the original author, not the sender — a forward
    // from another chat with this bot must not trigger an answer here.
    mockRoute.mockReturnValue('process');
    await onMessage(forwardedCtx('@bot что думаешь?'));

    expect(mockRun).not.toHaveBeenCalled();
    expect(vi.mocked(bufferForward)).toHaveBeenCalledOnce();
  });

  it('processes a forward the old way when the buffer is disabled', async () => {
    vi.mocked(isForwardBufferEnabled).mockReturnValueOnce(false);
    mockRoute.mockReturnValue('process');
    await onMessage(forwardedCtx('@bot что думаешь?'));

    expect(vi.mocked(bufferForward)).not.toHaveBeenCalled();
    expect(mockRun).toHaveBeenCalledOnce();
    // Passive learning still skips forwards regardless of the buffer flag.
    expect(mockLearnMemory).not.toHaveBeenCalled();
  });
});

describe('onMessage chat log', () => {
  it('logs a message the bot IGNORES — that is the whole point of the log', async () => {
    // conversation_turn only ever holds turns the bot took part in, so without this
    // «перескажи, что тут было» would summarise a chat it never heard.
    mockRoute.mockReturnValue('ignore');

    await onMessage(ctx('да ну его, поехали завтра'));

    expect(mockRun).not.toHaveBeenCalled();
    expect(mockLog).toHaveBeenCalledWith({
      chatId: 1,
      role: 'user',
      kind: 'text',
      tgUserId: 2,
      senderName: 'Tester',
      content: 'да ну его, поехали завтра',
      forwarded: false,
    });
  });

  it('tags a forwarded message as forwarded, and logs it despite the batch', async () => {
    mockRoute.mockReturnValue('ignore');

    await onMessage(forwardedCtx('В Москве открыли новый мост'));

    expect(mockLog).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'В Москве открыли новый мост', forwarded: true }),
    );
  });

  it('does not log commands (they are not chat)', async () => {
    await onMessage(ctx('/help'));
    expect(mockLog).not.toHaveBeenCalled();
  });
});
