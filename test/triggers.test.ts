import { describe, it, expect } from 'vitest';
import {
  looksLikeExpense,
  isAddressed,
  routeMessage,
  addressesBotByName,
} from '../src/bot/triggers.js';
import type { Context } from 'grammy';

function ctx(over: Record<string, unknown>): Context {
  return {
    me: { id: 999, username: 'SecretaryBot' },
    ...over,
  } as unknown as Context;
}

describe('looksLikeExpense', () => {
  it('matches spend-like text with a number', () => {
    expect(looksLikeExpense('я потратил 500 за такси')).toBe(true);
    expect(looksLikeExpense('dinner 60 split with Anna')).toBe(true);
    expect(looksLikeExpense('купил продукты на 500')).toBe(true);
  });
  it('ignores chatter and numberless text', () => {
    expect(looksLikeExpense('всем привет, как дела')).toBe(false);
    expect(looksLikeExpense('потратил кучу сил')).toBe(false);
    expect(looksLikeExpense('купил продуктов')).toBe(false); // no number
  });
});

describe('isAddressed', () => {
  it('always true in private chats', () => {
    expect(isAddressed(ctx({ chat: { type: 'private' } }))).toBe(true);
  });
  it('true when replying to the bot', () => {
    const c = ctx({
      chat: { type: 'group' },
      message: { reply_to_message: { from: { id: 999 } } },
    });
    expect(isAddressed(c)).toBe(true);
  });
  it('true on @mention of the bot', () => {
    const text = 'эй @SecretaryBot где корт';
    const c = ctx({
      chat: { type: 'group' },
      message: {
        text,
        entities: [{ type: 'mention', offset: 3, length: 13 }],
      },
    });
    expect(isAddressed(c)).toBe(true);
  });
  it('false for plain group chatter', () => {
    const c = ctx({ chat: { type: 'group' }, message: { text: 'привет' } });
    expect(isAddressed(c)).toBe(false);
  });
});

describe('addressesBotByName', () => {
  it('matches a question to the bot by its various names', () => {
    expect(addressesBotByName('Скай, какая погода в Чангу?')).toBe(true);
    expect(addressesBotByName('скайлер, посчитай сколько я потратил')).toBe(true);
    expect(addressesBotByName('миссис Вайт, напомни завтра позвонить')).toBe(true);
    expect(addressesBotByName('мисс вайт, что там по волнам')).toBe(true);
    expect(addressesBotByName('бот, сколько время в Токио?')).toBe(true);
    expect(addressesBotByName('ботик, расскажи анекдот')).toBe(true);
    expect(addressesBotByName('Sky, what is the weather?')).toBe(true);
    expect(addressesBotByName('Mrs White, when is the meeting?')).toBe(true);
  });

  it('requires both a name and a question/request marker', () => {
    expect(addressesBotByName('скай вчера лагал')).toBe(false); // name, no question
    expect(addressesBotByName('какая сегодня погода?')).toBe(false); // question, no name
    expect(addressesBotByName('спасибо, скай')).toBe(false); // name, just thanks
  });

  it('does not fire on words that merely contain the letters', () => {
    expect(addressesBotByName('сколько стоит работа сантехника?')).toBe(false);
    expect(addressesBotByName('где мои ботинки?')).toBe(false);
    expect(addressesBotByName('какой выбрать оборот речи?')).toBe(false);
  });
});

describe('routeMessage', () => {
  it('processes when addressed', () => {
    const c = ctx({ chat: { type: 'private' }, message: { text: 'hi' } });
    expect(routeMessage(c, 'hi')).toBe('process');
  });
  it('auto-expense for unaddressed spend in a group', () => {
    const c = ctx({ chat: { type: 'group' }, message: { text: 'потратил 500 за такси' } });
    expect(routeMessage(c, 'потратил 500 за такси')).toBe('auto-expense');
  });
  it('ignores unaddressed chatter in a group', () => {
    const c = ctx({ chat: { type: 'group' }, message: { text: 'привет всем' } });
    expect(routeMessage(c, 'привет всем')).toBe('ignore');
  });
});
