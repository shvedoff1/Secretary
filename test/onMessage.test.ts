import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'grammy';

vi.mock('../src/bot/triggers.js', () => ({
  routeMessage: vi.fn(),
  isAddressed: vi.fn(),
  addressesBotByName: vi.fn(),
}));
vi.mock('../src/bot/flows/assist.js', () => ({
  runAndRespond: vi.fn(),
  rewordPending: vi.fn(),
}));
vi.mock('../src/bot/flows/lexicon.js', () => ({
  learnFromMessage: vi.fn(() => Promise.resolve()),
}));
vi.mock('../src/bot/editTargets.js', () => ({
  getEditTarget: vi.fn(() => undefined),
}));
vi.mock('../src/bot/handlers/onPhoto.js', () => ({
  handleReceiptPhoto: vi.fn(),
}));

import { onMessage } from '../src/bot/handlers/onMessage.js';
import { routeMessage, addressesBotByName, isAddressed } from '../src/bot/triggers.js';
import { runAndRespond } from '../src/bot/flows/assist.js';
import { learnFromMessage } from '../src/bot/flows/lexicon.js';
import { handleReceiptPhoto } from '../src/bot/handlers/onPhoto.js';

const mockRoute = vi.mocked(routeMessage);
const mockByName = vi.mocked(addressesBotByName);
const mockAddressed = vi.mocked(isAddressed);
const mockRun = vi.mocked(runAndRespond);
const mockLearn = vi.mocked(learnFromMessage);
const mockPhoto = vi.mocked(handleReceiptPhoto);

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
