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

import { onVoice } from '../src/bot/handlers/onVoice.js';
import { isTranscriptionEnabled, transcribeAudio } from '../src/llm/transcribe.js';
import { isAddressed, routeMessage, addressesBotByName } from '../src/bot/triggers.js';
import { runAndRespond } from '../src/bot/flows/assist.js';

const mockEnabled = vi.mocked(isTranscriptionEnabled);
const mockTranscribe = vi.mocked(transcribeAudio);
const mockAddressed = vi.mocked(isAddressed);
const mockRoute = vi.mocked(routeMessage);
const mockByName = vi.mocked(addressesBotByName);
const mockRun = vi.mocked(runAndRespond);

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
