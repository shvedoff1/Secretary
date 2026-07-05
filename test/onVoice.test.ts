import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'grammy';

// dmTranscriptToAdmin reads config (admin id); config isn't mocked here, so seed
// a valid env before anything imports it.
process.env.BOT_TOKEN = 'x';
process.env.ANTHROPIC_API_KEY = 'x';
process.env.ADMIN_TELEGRAM_ID = '123';

vi.mock('../src/llm/transcribe.js', () => ({
  isTranscriptionEnabled: vi.fn(),
  transcribeAudio: vi.fn(),
}));
vi.mock('../src/util/telegramFile.js', () => ({
  downloadTelegramFile: vi.fn(async () => Buffer.from('audio')),
}));
vi.mock('../src/bot/triggers.js', () => ({
  isAddressed: vi.fn(),
  routeMessage: vi.fn(),
  addressesBotByName: vi.fn(),
}));
vi.mock('../src/bot/flows/assist.js', () => ({
  runAndRespond: vi.fn(),
  senderName: () => 'Tester',
}));
vi.mock('../src/bot/flows/lexicon.js', () => ({
  learnFromMessage: vi.fn(() => Promise.resolve()),
}));
vi.mock('../src/bot/flows/memory.js', () => ({
  learnMemoryFromMessage: vi.fn(() => Promise.resolve()),
}));
vi.mock('../src/bot/handlers/onPhoto.js', () => ({
  handleReceiptPhoto: vi.fn(),
}));

import { onVoice } from '../src/bot/handlers/onVoice.js';
import { isTranscriptionEnabled, transcribeAudio } from '../src/llm/transcribe.js';
import { isAddressed, routeMessage, addressesBotByName } from '../src/bot/triggers.js';
import { runAndRespond } from '../src/bot/flows/assist.js';
import { handleReceiptPhoto } from '../src/bot/handlers/onPhoto.js';

const mockEnabled = vi.mocked(isTranscriptionEnabled);
const mockTranscribe = vi.mocked(transcribeAudio);
const mockAddressed = vi.mocked(isAddressed);
const mockRoute = vi.mocked(routeMessage);
const mockByName = vi.mocked(addressesBotByName);
const mockRun = vi.mocked(runAndRespond);
const mockPhoto = vi.mocked(handleReceiptPhoto);

// Bare writing-hand codepoint (no variation selector) — the only form Telegram
// accepts as a reaction.
const WRITING = '✍';

function fakeCtx(over: { chat?: Record<string, unknown> } = {}) {
  const react = vi.fn(async () => {});
  const reply = vi.fn(async () => {});
  const sendMessage = vi.fn(async () => {});
  const ctx = {
    message: { voice: { file_id: 'f', mime_type: 'audio/ogg' } },
    chat: { id: 1, type: 'group', title: 'Surf Crew', ...over.chat },
    from: { id: 2, first_name: 'Ваня' },
    react,
    reply,
    api: { sendMessage },
  } as unknown as Context;
  return { ctx, react, reply, sendMessage };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockByName.mockReturnValue(false); // off unless a test opts in
});

describe('onVoice reaction lifecycle', () => {
  it('keeps the ✍️ reaction when the voice note becomes an expense', async () => {
    mockEnabled.mockReturnValue(true);
    mockTranscribe.mockResolvedValue('кофе 200');
    mockAddressed.mockReturnValue(false);
    mockRoute.mockReturnValue('auto-expense');
    mockRun.mockResolvedValue('expense');

    const { ctx, react } = fakeCtx();
    await onVoice(ctx);

    expect(react).toHaveBeenCalledTimes(1);
    expect(react).toHaveBeenCalledWith(WRITING);
  });

  it('clears the reaction when no expense is found (text reply)', async () => {
    mockEnabled.mockReturnValue(true);
    mockTranscribe.mockResolvedValue('как дела?');
    mockAddressed.mockReturnValue(true);
    mockRoute.mockReturnValue('process');
    mockRun.mockResolvedValue('replied');

    const { ctx, react } = fakeCtx();
    await onVoice(ctx);

    expect(react).toHaveBeenCalledTimes(2);
    expect(react).toHaveBeenNthCalledWith(1, WRITING);
    expect(react).toHaveBeenNthCalledWith(2, []);
  });

  it('marks then clears an ignored group voice note, without calling the assistant', async () => {
    mockEnabled.mockReturnValue(true);
    mockTranscribe.mockResolvedValue('просто болтаю');
    mockAddressed.mockReturnValue(false);
    mockRoute.mockReturnValue('ignore');

    const { ctx, react } = fakeCtx();
    await onVoice(ctx);

    expect(react).toHaveBeenNthCalledWith(1, WRITING);
    expect(react).toHaveBeenNthCalledWith(2, []);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('answers a by-name question even when routing would ignore it', async () => {
    mockEnabled.mockReturnValue(true);
    mockTranscribe.mockResolvedValue('Скай, какая погода?');
    mockAddressed.mockReturnValue(false);
    mockRoute.mockReturnValue('ignore'); // not an expense, not @-addressed
    mockByName.mockReturnValue(true); // …but it names the bot with a question
    mockRun.mockResolvedValue('replied');

    const { ctx } = fakeCtx();
    await onVoice(ctx);

    expect(mockRun).toHaveBeenCalledOnce();
    expect(mockRun.mock.calls[0]?.[1]).toMatchObject({ addressed: true });
  });

  it('clears the reaction and nags (when addressed) on an empty transcript', async () => {
    mockEnabled.mockReturnValue(true);
    mockTranscribe.mockResolvedValue('');
    mockAddressed.mockReturnValue(true);

    const { ctx, react, reply } = fakeCtx();
    await onVoice(ctx);

    expect(react).toHaveBeenNthCalledWith(1, WRITING);
    expect(react).toHaveBeenNthCalledWith(2, []);
    expect(reply).toHaveBeenCalledOnce();
    expect(mockRoute).not.toHaveBeenCalled();
  });

  it('clears the reaction when transcription throws', async () => {
    mockEnabled.mockReturnValue(true);
    mockTranscribe.mockRejectedValue(new Error('openai down'));
    mockAddressed.mockReturnValue(false);

    const { ctx, react } = fakeCtx();
    await onVoice(ctx);

    expect(react).toHaveBeenNthCalledWith(1, WRITING);
    expect(react).toHaveBeenNthCalledWith(2, []);
  });

  it('DMs the admin the transcript (with chat + sender) on a successful transcription', async () => {
    mockEnabled.mockReturnValue(true);
    mockTranscribe.mockResolvedValue('кофе 200');
    mockAddressed.mockReturnValue(false);
    mockRoute.mockReturnValue('auto-expense');
    mockRun.mockResolvedValue('expense');

    const { ctx, sendMessage } = fakeCtx();
    await onVoice(ctx);

    expect(sendMessage).toHaveBeenCalledOnce();
    const [adminId, text] = sendMessage.mock.calls[0] as [number, string];
    expect(adminId).toBe(123);
    expect(text).toContain('кофе 200');
    expect(text).toContain('Surf Crew');
    expect(text).toContain('Ваня');
  });

  it('does not DM the admin when they sent the note in their own DM', async () => {
    mockEnabled.mockReturnValue(true);
    mockTranscribe.mockResolvedValue('напомни купить молоко');
    mockAddressed.mockReturnValue(true);
    mockRoute.mockReturnValue('process');
    mockRun.mockResolvedValue('replied');

    // Admin's private chat: chat.id === ADMIN_TELEGRAM_ID.
    const { ctx, sendMessage } = fakeCtx({ chat: { id: 123, type: 'private' } });
    await onVoice(ctx);

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('does not DM the admin on an empty transcript', async () => {
    mockEnabled.mockReturnValue(true);
    mockTranscribe.mockResolvedValue('');
    mockAddressed.mockReturnValue(false);

    const { ctx, sendMessage } = fakeCtx();
    await onVoice(ctx);

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('does not react at all when transcription is disabled', async () => {
    mockEnabled.mockReturnValue(false);
    mockAddressed.mockReturnValue(true);

    const { ctx, react, reply } = fakeCtx();
    await onVoice(ctx);

    expect(react).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledOnce(); // nag, because addressed
    expect(mockTranscribe).not.toHaveBeenCalled();
  });
});

// A voice note that REPLIES to a photo is a spoken receipt split: the amounts are
// in the picture, the voice says who had what. It must reach the receipt handler
// (like the text «reply to a photo» path), not be routed as standalone text where
// it looks like nothing and gets ignored — the "photo + голосовое = ничего" bug.
describe('onVoice reply to a photo (spoken receipt split)', () => {
  function voiceReplyToPhotoCtx(
    transcript: string,
    replyOver: Record<string, unknown> = {},
  ) {
    const react = vi.fn(async () => {});
    const reply = vi.fn(async () => {});
    const sendMessage = vi.fn(async () => {});
    const photo = [{ file_id: 'small' }, { file_id: 'big' }];
    const ctx = {
      message: {
        voice: { file_id: 'f', mime_type: 'audio/ogg' },
        reply_to_message: { message_id: 42, photo, ...replyOver },
      },
      chat: { id: 1, type: 'group', title: 'Surf Crew' },
      from: { id: 2, first_name: 'Андрей', last_name: 'Шведов' },
      react,
      reply,
      api: { sendMessage },
    } as unknown as Context;
    mockEnabled.mockReturnValue(true);
    mockTranscribe.mockResolvedValue(transcript);
    return { ctx, react, photo };
  }

  it('feeds the photo + transcript to the receipt handler instead of routing as text', async () => {
    mockAddressed.mockReturnValue(false); // a reply to a user's photo isn't "addressed"
    const { ctx, photo } = voiceReplyToPhotoCtx('бургер у меня, креветки у Ивана');

    await onVoice(ctx);

    expect(mockPhoto).toHaveBeenCalledOnce();
    const [, photos, caption, addressed] = mockPhoto.mock.calls[0]!;
    expect(photos).toBe(photo);
    expect(caption).toBe('бургер у меня, креветки у Ивана');
    expect(addressed).toBe(false); // silent unless it really is an expense
    // Must NOT fall through to the plain-text routing path.
    expect(mockRoute).not.toHaveBeenCalled();
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('keeps the photo original caption alongside the spoken split', async () => {
    mockAddressed.mockReturnValue(false);
    const { ctx } = voiceReplyToPhotoCtx('бургер у меня, октопс у шведа', {
      caption: 'на меня Ивана и Антона',
    });

    await onVoice(ctx);

    const caption = mockPhoto.mock.calls[0]![2];
    expect(caption).toContain('на меня Ивана и Антона');
    expect(caption).toContain('бургер у меня, октопс у шведа');
  });

  it('treats it as addressed when the transcript names the bot with a request', async () => {
    mockAddressed.mockReturnValue(false);
    mockByName.mockReturnValue(true); // «Скай, посчитай …»
    const { ctx } = voiceReplyToPhotoCtx('Скай, посчитай чек, бургер у меня');

    await onVoice(ctx);

    expect(mockPhoto.mock.calls[0]![3]).toBe(true);
  });

  it('clears the ✍️ ack before delegating to the receipt handler', async () => {
    mockAddressed.mockReturnValue(false);
    const { ctx, react } = voiceReplyToPhotoCtx('бургер у меня');

    await onVoice(ctx);

    expect(react).toHaveBeenNthCalledWith(1, WRITING);
    expect(react).toHaveBeenNthCalledWith(2, []);
  });
});
