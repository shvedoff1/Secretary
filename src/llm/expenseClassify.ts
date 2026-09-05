import type Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { getAnthropic } from './client.js';

// Second source of the `memoryFree` flag (the first is the deterministic
// `isExpenseShaped` regex gate in bot/triggers.ts): a cheap yes/no pass on an
// ADDRESSED message the regex didn't catch («скинь Ване за ужин» — no number,
// «это на всех» after a receipt). It answers ONE question — is this message
// reporting a shared expense to record/split NOW? — and the answer switches the
// memory tiers off for the main call, so the expense's title/amount/people can
// only come from the message itself.
//
// What it sees is deliberately narrow: the message, the roster (so «Ване» reads
// as a member), and the last few conversation turns (so «и ещё 300 за такси» is
// recognised as a continuation). NEVER memory, profiles or the journal — that
// would just move the leak one call down. Fail-OPEN on any failure: an unknown
// verdict keeps today's behaviour (memory on), so a Haiku outage can't break
// ordinary questions; the regex gate still covers the clear-cut spends.
const CLASSIFY_SYSTEM = `You classify ONE chat message for a shared-expense bot.
Answer whether the LAST message is primarily REPORTING A SHARED EXPENSE to be
recorded/split right now: someone spent or paid money (an amount, or a receipt
in the picture the caption refers to) and it should be logged / split between
people («такси 500 на всех», «скинь Ване за ужин», «раздели чек на нас», «это на
меня и Колю», "dinner 60 split with Anna», a follow-up «и ещё 300 за кофе» right
after such a message).

NOT an expense (expense=false): reminders and future plans («напомни заплатить
за аренду»), questions about prices or spending («сколько мы потратили?», «почём
такси?»), asking the bot to remember something, balances/debts talk without a
new purchase, jokes, greetings, general chat, and anything where nobody actually
spent money now. When in doubt => false (the message then runs the normal way).

Output ONLY JSON (no prose, no markdown fences): {"expense": <boolean>}`;

export type ExpenseVerdict = 'expense' | 'other' | 'unknown';

/**
 * Parse the model's verdict defensively: the outermost JSON object with a boolean
 * `expense`. Anything else is 'unknown' (fail-open — memory stays on), never a throw.
 */
export function parseExpenseVerdict(text: string): ExpenseVerdict {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return 'unknown';
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return 'unknown';
  }
  if (!parsed || typeof parsed !== 'object') return 'unknown';
  const v = (parsed as { expense?: unknown }).expense;
  if (v === true) return 'expense';
  if (v === false) return 'other';
  return 'unknown';
}

export interface ClassifyArgs {
  /** The message as the user sent it (voice transcript / text / photo caption). */
  text: string;
  senderName: string;
  /** Channel the message came in on — a caption's amount may live in the picture. */
  source: string;
  /** Group roster names, so a first name in the message reads as a member. */
  members: string[];
  /** The last few conversation turns, oldest first, already rendered as «Имя: текст». */
  recent: string[];
}

/** Render the classifier's user turn — exported so a test can pin what it sees. */
export function renderClassifyInput(args: ClassifyArgs): string {
  const roster = args.members.length > 0 ? args.members.join(', ') : '(unknown)';
  const recent =
    args.recent.length > 0 ? args.recent.map((l) => `  ${l}`).join('\n') : '  (none)';
  return (
    `Group members: ${roster}\n` +
    `Recent turns (oldest first):\n${recent}\n\n` +
    `LAST message (channel: ${args.source}) from ${args.senderName}:\n${args.text}`
  );
}

/**
 * Ask the cheap model whether the message reports a shared expense. Bounded by
 * `EXPENSE_CLASSIFY_TIMEOUT_MS` with no retries — it sits in front of every
 * addressed reply, so a slow verdict is worth less than no verdict. Best-effort:
 * any failure returns 'unknown' and the caller keeps memory on.
 */
export async function classifyExpenseIntent(args: ClassifyArgs): Promise<ExpenseVerdict> {
  const cfg = loadConfig();
  try {
    const res = await getAnthropic().messages.create(
      {
        model: cfg.ANTHROPIC_CLASSIFY_MODEL,
        max_tokens: 64,
        temperature: 0,
        system: CLASSIFY_SYSTEM,
        messages: [{ role: 'user', content: renderClassifyInput(args) }],
      },
      { timeout: cfg.EXPENSE_CLASSIFY_TIMEOUT_MS, maxRetries: 0 },
    );
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    return parseExpenseVerdict(text);
  } catch (err) {
    logger.warn({ err }, 'expense classifier failed — memory stays on for this turn');
    return 'unknown';
  }
}
