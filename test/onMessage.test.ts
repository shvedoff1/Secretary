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
vi.mock('../src/bot/editTargets.js', () => ({
  getEditTarget: vi.fn(() => undefined),
}));
vi.mock('../src/bot/handlers/onPhoto.js', () => ({
  handleReceiptPhoto: vi.fn(),
}));

import { onMessage } from '../src/bot/handlers/onMessage.js';
import { routeMessage, addressesBotByName } from '../src/bot/triggers.js';
import { runAndRespond } from '../src/bot/flows/assist.js';

const mockRoute = vi.mocked(routeMessage);
const mockByName = vi.mocked(addressesBotByName);
const mockRun = vi.mocked(runAndRespond);

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

  it('keeps an unaddressed expense as a silent auto-expense scan', async () => {
    mockRoute.mockReturnValue('auto-expense');
    mockByName.mockReturnValue(false);

    await onMessage(ctx('потратил 500 на такси'));

    expect(mockRun).toHaveBeenCalledOnce();
    expect(mockRun.mock.calls[0]?.[1]).toMatchObject({ addressed: false });
  });
});
