import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Context } from 'grammy';

// looksLikeExpenseForChat reaches into chat_expense_term, so it needs a live DB.
// Reset modules, migrate a fresh in-memory DB, then import the repo + triggers so
// both bind to the same connection.
async function fresh() {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  vi.resetModules();
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
  const repo = await import('../src/db/repos/expenseTerm.repo.js');
  const triggers = await import('../src/bot/triggers.js');
  return { repo, triggers };
}

let closeDb: () => void;
afterEach(async () => {
  if (closeDb) closeDb();
});
beforeEach(async () => {
  ({ closeDb } = await import('../src/db/client.js'));
});

describe('looksLikeExpenseForChat', () => {
  it('falls back to the base heuristic when nothing is taught', async () => {
    const { triggers } = await fresh();
    expect(triggers.looksLikeExpenseForChat(1, 'потратил 500 за такси')).toBe(true);
    expect(triggers.looksLikeExpenseForChat(1, 'дошик 200')).toBe(false); // unknown word
  });

  it('matches a learned term (still requires a number)', async () => {
    const { repo, triggers } = await fresh();
    repo.addExpenseTerms(1, ['дошик'], null);
    // "дошик 200" hits no base keyword — only the learned term makes it an expense.
    expect(triggers.looksLikeExpenseForChat(1, 'дошик 200')).toBe(true);
    // No number → still not an expense, even with a known word.
    expect(triggers.looksLikeExpenseForChat(1, 'просто дошик')).toBe(false);
    // A learned term is scoped to its chat.
    expect(triggers.looksLikeExpenseForChat(2, 'дошик 200')).toBe(false);
  });

  it('isMoneyContext judges the user message via the learned dict, ignoring the reply', async () => {
    const { repo, triggers } = await fresh();
    repo.addExpenseTerms(1, ['таблетки'], null);

    // User message with a learned term + number → money (don't humorize it).
    expect(triggers.isMoneyContext({ source: 'text', userText: 'таблетки 200', chatId: 1 })).toBe(
      true,
    );

    // The regression: a harmless user message stays humorizable even in a chat
    // that has taught expense words. The bot's reply is no longer an input, so its
    // roast (which may riff "таблетки 96%") can't flip this to money anymore.
    expect(
      triggers.isMoneyContext({ source: 'text', userText: 'выдай юмореску над шведом', chatId: 1 }),
    ).toBe(false);
  });

  it('routeMessage auto-expenses an unaddressed message with a learned term', async () => {
    const { repo, triggers } = await fresh();
    repo.addExpenseTerms(7, ['дошик'], null);
    const ctx = {
      me: { id: 999, username: 'SecretaryBot' },
      chat: { id: 7, type: 'group' },
      message: { text: 'дошик 200' },
    } as unknown as Context;
    expect(triggers.routeMessage(ctx, 'дошик 200')).toBe('auto-expense');
  });
});
