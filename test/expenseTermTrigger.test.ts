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

  it('isMoneyContext applies the learned dict to the user message, NOT the bot reply', async () => {
    const { repo, triggers } = await fresh();
    repo.addExpenseTerms(1, ['таблетки'], null);

    // User message with a learned term + number → money (don't humorize it).
    expect(
      triggers.isMoneyContext({
        source: 'text',
        userText: 'таблетки 200',
        replyText: 'ок',
        chatId: 1,
      }),
    ).toBe(true);

    // The exact regression: a long playful reply that merely mentions the learned
    // word plus stray numbers must NOT be flagged as money — it has to reach the
    // humorizer. The base heuristic still has no claim on it.
    expect(
      triggers.isMoneyContext({
        source: 'text',
        userText: 'распиши с вероятностями',
        replyText: 'Просрётся сегодня — 74%, таблетки могут влиять, держись бро 🤙',
        chatId: 1,
      }),
    ).toBe(false);

    // But a genuine money breakdown in the reply still trips the BASE heuristic
    // (spend word + amount), so amounts are never sent to OpenAI.
    expect(
      triggers.isMoneyContext({
        source: 'text',
        userText: 'раскинь',
        replyText: 'ужин 1500 на всех',
        chatId: 1,
      }),
    ).toBe(true);
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
