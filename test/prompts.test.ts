import { describe, it, expect } from 'vitest';
import { SYSTEM_PROMPT, buildContextBlock } from '../src/llm/prompts.js';

// Guard the web-search guidance so it can't be silently dropped (the model only
// searches when the prompt tells it to — there's no deterministic trigger).
describe('SYSTEM_PROMPT web-search guidance', () => {
  it('tells the model to always search when explicitly asked', () => {
    expect(SYSTEM_PROMPT).toContain('web_search');
    // An explicit request must force a search ("ALWAYS call web_search ...").
    expect(SYSTEM_PROMPT).toMatch(/ALWAYS call `?web_search/);
    expect(SYSTEM_PROMPT.toLowerCase()).toContain('загугли');
  });
});

// Guard the page-watch routing: «следи за <url> и напиши, когда появятся …» must
// go to watch_page, not become a once-a-day schedule_task cron check (a real
// misroute that shipped once — the daily check would simply miss the event).
describe('SYSTEM_PROMPT page-watch routing', () => {
  it('carves page watches out of the reminders job and points at watch_page', () => {
    expect(SYSTEM_PROMPT).toContain('watch_page');
    expect(SYSTEM_PROMPT).toContain('NOT A REMINDER');
    expect(SYSTEM_PROMPT).toContain('Active page watches');
  });
});

// Slang now rides ONLY on the OpenAI humorizer, not Claude — Claude gets clean
// history/context. Guard that the lexicon block is gone from the model's prompt
// so it can't silently creep back in.
describe('SYSTEM_PROMPT no longer carries the chat lexicon', () => {
  it('does not reference a "Chat lexicon" block (slang moved to the humorizer)', () => {
    expect(SYSTEM_PROMPT).not.toContain('Chat lexicon');
  });
});

describe('SYSTEM_PROMPT memory guidance', () => {
  it('tells the model about the chat-memory and per-person sections', () => {
    expect(SYSTEM_PROMPT).toContain('Chat memory');
    expect(SYSTEM_PROMPT).toContain('About <name>');
  });

  it('tells the model to follow the voice/style section', () => {
    expect(SYSTEM_PROMPT).toContain('Voice & style');
  });

  it('tells the model to override contradictions via replaces, after one pushback', () => {
    expect(SYSTEM_PROMPT).toContain('replaces');
    expect(SYSTEM_PROMPT).toMatch(/push back ONCE/);
    expect(SYSTEM_PROMPT).toContain('edit_memory');
  });

  it('carves the written-memory exception into the accept-facts rule', () => {
    // A plain factual correction is still accepted, but a contradiction of WRITTEN
    // memory may earn one pushback — guard that the carve-out is present.
    expect(SYSTEM_PROMPT).toMatch(/WRITTEN in the chat memory/);
  });
});

// Memory must never be what decides who is speaking or who paid. A remembered
// «я — Швед» once made the bot take the payer from memory instead of the sender
// («Швед купил круассан», sent by Андрей Шведов) and reason about it out loud.
describe('SYSTEM_PROMPT identity vs memory', () => {
  it('forbids taking the payer from memory', () => {
    expect(SYSTEM_PROMPT).toContain('MEMORY NEVER NAMES THE PAYER');
    // «я» must survive as «я» — it resolves to the sender deterministically.
    expect(SYSTEM_PROMPT).toMatch(/LEAVE it as "я"/);
  });

  it('pins «я» inside an About block to that block’s subject', () => {
    expect(SYSTEM_PROMPT).toContain('MEMORY NEVER DECIDES WHO IS SPEAKING');
    expect(SYSTEM_PROMPT).toMatch(/"Message sender" wins/);
  });
});

// A voice transcript mangles names («Швец» вместо «Швед»). Repairing that from
// MEMORY is what put «судя по памяти чата, это Швед» into a preview's notes — the
// roster is the authority on who exists, and notes are data, not reasoning.
describe('SYSTEM_PROMPT garbled names and notes hygiene', () => {
  it('sends a garbled name to the roster, not to memory', () => {
    expect(SYSTEM_PROMPT).toContain('GARBLED NAME IS MATCHED AGAINST THE ROSTER');
    // The sender's own mis-heard name collapses to the deterministic «я».
    expect(SYSTEM_PROMPT).toMatch(/it is\s+the sender — emit "я"/);
  });

  it('keeps reasoning out of the notes field', () => {
    expect(SYSTEM_PROMPT).toContain('`notes` IS DATA, NOT REASONING');
    expect(SYSTEM_PROMPT).toContain('судя по памяти чата');
  });
});

// A receipt with items belonging to different people must split into several
// expenses, and "everyone except X" must be expanded from the roster — both were
// the cases the bot used to fluff, so guard the guidance against silent removal.
describe('SYSTEM_PROMPT receipt-splitting guidance', () => {
  it('tells the model to emit several record_expense calls per group', () => {
    expect(SYSTEM_PROMPT).toContain('GROUPS');
    expect(SYSTEM_PROMPT).toMatch(/SEVERAL\s+`?record_expense/);
  });

  it('tells the model to expand "everyone except X" from the roster', () => {
    expect(SYSTEM_PROMPT).toContain('EXCEPT');
  });

  // The sender often names themselves in the third person by name/nickname and
  // mixes it with "я"/"у меня" («Андрей это швед, платил я»); the model used to
  // spawn a phantom member and stall over who paid. Guard the self-reference note.
  it('tells the model to fold the sender\'s own name/nickname into "я"', () => {
    expect(SYSTEM_PROMPT).toContain('SELF-REFERENCE');
    expect(SYSTEM_PROMPT).toMatch(/third person/);
  });
});

// The bot used to instantly agree with any pushback. It should now defend its own
// take 1-2 times before conceding — but ONLY for opinions/banter, never for facts
// or task data (reminder times, expense amounts, who splits). Guard both halves so
// the resistance can't creep into factual corrections or get silently dropped.
describe('SYSTEM_PROMPT argument-resistance guidance', () => {
  it('tells the model to hold its position for 1-2 rounds before conceding', () => {
    expect(SYSTEM_PROMPT).toContain('Standing your ground');
    expect(SYSTEM_PROMPT).toMatch(/1-2 rounds/);
    expect(SYSTEM_PROMPT).toMatch(/do NOT\s+instantly cave/);
  });

  it('scopes resistance to opinions only — never facts or task data', () => {
    expect(SYSTEM_PROMPT).toMatch(/ONLY for opinions/);
    expect(SYSTEM_PROMPT).toMatch(/NEVER argue about task data/);
    // A corrected fact must be accepted, not argued.
    expect(SYSTEM_PROMPT).toMatch(/corrects a FACT/);
  });
});

// The bot mixed people up in groups and @-tagged the wrong person. Guard the
// guidance that explains the "Name: message" labelling and forbids @-mentions.
describe('SYSTEM_PROMPT name & mention guidance', () => {
  it('explains that each message is prefixed with its author name', () => {
    expect(SYSTEM_PROMPT).toContain("Who's talking");
    expect(SYSTEM_PROMPT).toMatch(/prefixed with its author'?s name/);
  });

  it('forbids @-tagging so it never pings the wrong person', () => {
    expect(SYSTEM_PROMPT).toMatch(/@-tag|@-mention/);
    expect(SYSTEM_PROMPT).toContain('WRONG person');
  });
});

describe('buildContextBlock never carries slang', () => {
  const base = {
    defaultCurrency: 'EUR',
    members: [],
    senderName: 'Sky',
    timezone: null,
    splidConnected: false,
  };

  it('renders no lexicon section (slang lives on the humorizer now)', () => {
    const out = buildContextBlock(base);
    expect(out).not.toContain('Chat lexicon');
    expect(out).not.toContain('lexicon');
  });
});

describe('buildContextBlock memory sections', () => {
  const base = {
    defaultCurrency: 'EUR',
    members: [],
    senderName: 'Sky',
    timezone: null,
    splidConnected: false,
  };

  it('renders the shared chat-memory section and per-person sections', () => {
    const out = buildContextBlock({
      ...base,
      memoryChat: [{ content: 'едут на Бали' }],
      memoryUsers: [
        { subject: 'Sky', items: [{ content: 'любит серф' }] },
        { subject: 'Max', items: [{ content: 'веган' }] },
      ],
    });
    expect(out).toContain('Chat memory');
    expect(out).toContain('- едут на Бали');
    expect(out).toContain('About Sky');
    expect(out).toContain('- любит серф');
    expect(out).toContain('About Max');
    // The sender's section comes before other participants'.
    expect(out.indexOf('About Sky')).toBeLessThan(out.indexOf('About Max'));
  });

  it('omits memory sections entirely when empty (fresh chat stays clean)', () => {
    const out = buildContextBlock(base);
    expect(out).not.toContain('Chat memory');
    expect(out).not.toContain('About ');
    expect(out).not.toContain('Voice & style');
    const out2 = buildContextBlock({ ...base, memoryChat: [], memoryUsers: [] });
    expect(out2).not.toContain('Chat memory');
  });

  it('renders the voice/style section separately from facts', () => {
    const out = buildContextBlock({
      ...base,
      memoryPersona: [{ content: 'говори как серфер, эмодзи 🤙 уместны' }],
      memoryChat: [{ content: 'едут на Бали' }],
    });
    expect(out).toContain('Voice & style for this chat');
    expect(out).toContain('- говори как серфер, эмодзи 🤙 уместны');
    // Style comes before the factual chat memory.
    expect(out.indexOf('Voice & style')).toBeLessThan(out.indexOf('Chat memory'));
  });
});

// The expense-only scan (an unaddressed "looks like a spend" message) renders a
// stripped block: nothing that only feeds conversation, because that turn can only
// record an expense or produce nothing — and a remembered «я — Швед» was actively
// misleading the payer.
describe('buildContextBlock expense-only scan', () => {
  const base = {
    defaultCurrency: 'EUR',
    members: [{ name: 'Андрей Шведов' }],
    senderName: 'Андрей Шведов',
    timezone: 'Asia/Makassar',
    splidConnected: true,
    memoryChat: [{ content: 'едут на Бали' }],
    memoryUsers: [{ subject: 'Андрей Шведов', items: [{ content: 'Швед — это я' }] }],
    memoryPersona: [{ content: 'говори как серфер' }],
    memoryTotal: 30,
    activeReminders: [{ id: 1, title: 'встать', when: 'завтра' }],
    activeWatches: [{ id: 2, title: 'сеансы', url: 'https://x.test' }],
    places: [{ name: 'Кафе', category: 'cafe' }],
  };

  it('drops memory and every conversation-only section', () => {
    const out = buildContextBlock({ ...base, expenseOnly: true });
    expect(out).not.toContain('Chat memory');
    expect(out).not.toContain('About Андрей Шведов');
    expect(out).not.toContain('Швед — это я');
    expect(out).not.toContain('Voice & style');
    expect(out).not.toContain('Memory store');
    expect(out).not.toContain('Active reminders');
    expect(out).not.toContain('Active page watches');
    expect(out).not.toContain('Saved places');
  });

  it('keeps what an expense needs — sender, roster, currency, timezone, rules', () => {
    const out = buildContextBlock({
      ...base,
      expenseOnly: true,
      rules: ['отвечай короче'],
    });
    expect(out).toContain('Message sender: Андрей Шведов');
    expect(out).toContain('Group members: Андрей Шведов');
    expect(out).toContain('Chat default currency: EUR');
    expect(out).toContain('Chat timezone: Asia/Makassar');
    expect(out).toContain('Splid: connected');
    expect(out).toContain('1. отвечай короче');
  });

  it('renders everything as before without the flag', () => {
    const out = buildContextBlock(base);
    expect(out).toContain('Chat memory');
    expect(out).toContain('About Андрей Шведов');
    expect(out).toContain('Active reminders');
    expect(out).toContain('Memory store: 30 facts total, 3 shown above');
  });
});

// Tutor mode is the "no jokes, accuracy first" persona — guard both directions:
// the tutor prompt must demand rigor and must NOT drag in the secretary vibe.
describe('TUTOR_SYSTEM_PROMPT', () => {
  it('demands step-by-step solutions with a final answer line and self-checking', async () => {
    const { TUTOR_SYSTEM_PROMPT } = await import('../src/llm/prompts.js');
    expect(TUTOR_SYSTEM_PROMPT).toContain('ПОШАГОВО');
    expect(TUTOR_SYSTEM_PROMPT).toContain('Ответ:');
    expect(TUTOR_SYSTEM_PROMPT).toContain('ПЕРЕПРОВЕРЯЙ');
  });

  it('targets 9th-grade exam prep (ОГЭ) with math and physics', async () => {
    const { TUTOR_SYSTEM_PROMPT } = await import('../src/llm/prompts.js');
    expect(TUTOR_SYSTEM_PROMPT).toContain('ОГЭ');
    expect(TUTOR_SYSTEM_PROMPT).toContain('математика');
    expect(TUTOR_SYSTEM_PROMPT).toContain('физика');
  });

  it('bans the secretary slang explicitly and never mentions surf/expenses', async () => {
    const { TUTOR_SYSTEM_PROMPT } = await import('../src/llm/prompts.js');
    expect(TUTOR_SYSTEM_PROMPT).toContain('БЕЗ сленга');
    expect(TUTOR_SYSTEM_PROMPT.toLowerCase()).not.toContain('surf');
    expect(TUTOR_SYSTEM_PROMPT.toLowerCase()).not.toContain('splid');
    expect(TUTOR_SYSTEM_PROMPT).not.toContain('record_expense');
  });

  it('still points at the study-relevant tools (search, memory, reminders)', async () => {
    const { TUTOR_SYSTEM_PROMPT } = await import('../src/llm/prompts.js');
    expect(TUTOR_SYSTEM_PROMPT).toContain('web_search');
    expect(TUTOR_SYSTEM_PROMPT).toContain('remember');
    expect(TUTOR_SYSTEM_PROMPT).toContain('schedule_task');
  });
});

// Dota mode is secretary-with-a-different-persona: the prompt must carry the
// schoolkid-sensei character AND keep every secretary capability (it is built on
// top of SYSTEM_PROMPT, so tools/memory/expense guidance all survive).
describe('DOTA_SYSTEM_PROMPT', () => {
  it('keeps the full secretary prompt as its base', async () => {
    const { DOTA_SYSTEM_PROMPT, SYSTEM_PROMPT } = await import('../src/llm/prompts.js');
    expect(DOTA_SYSTEM_PROMPT.startsWith(SYSTEM_PROMPT)).toBe(true);
  });

  it('sets the schoolkid-turned-dota-teacher persona', async () => {
    const { DOTA_SYSTEM_PROMPT } = await import('../src/llm/prompts.js');
    expect(DOTA_SYSTEM_PROMPT).toContain('ШКОЛЬНИК');
    expect(DOTA_SYSTEM_PROMPT).toContain('УЧИТЕЛЕМ');
    expect(DOTA_SYSTEM_PROMPT).toContain('Dota 2');
  });

  it('swaps the surfer slang out for dota slang', async () => {
    const { DOTA_SYSTEM_PROMPT } = await import('../src/llm/prompts.js');
    expect(DOTA_SYSTEM_PROMPT).toContain('вардить');
    // The persona override explicitly bans the surfer vocabulary.
    expect(DOTA_SYSTEM_PROMPT).toMatch(/«чилл», «вайб»[\s\S]*?НЕ используешь/);
  });

  it('points party-gathering requests at the /ping command instead of @-tags', async () => {
    const { DOTA_SYSTEM_PROMPT } = await import('../src/llm/prompts.js');
    expect(DOTA_SYSTEM_PROMPT).toContain('/ping');
    expect(DOTA_SYSTEM_PROMPT).toContain('/ping show');
    expect(DOTA_SYSTEM_PROMPT).toContain('edit_ping_list');
    expect(DOTA_SYSTEM_PROMPT).toMatch(/никого не\s+@-тегаешь/);
  });
});

// Roster editing in plain words («добавь @vasya в основной пинг») rides on the
// edit_ping_list tool — guard the guidance so the model knows when to call it and
// never re-pings people in its confirmation.
describe('SYSTEM_PROMPT ping-roster guidance', () => {
  it('tells the model to call edit_ping_list for worded add/remove requests', () => {
    expect(SYSTEM_PROMPT).toContain('edit_ping_list');
    expect(SYSTEM_PROMPT).toContain('добавь @vasya в основной пинг');
    expect(SYSTEM_PROMPT).toContain('/ping show');
  });

  it('forbids repeating @usernames in the confirmation (that would ping them)', () => {
    expect(SYSTEM_PROMPT).toMatch(/do NOT repeat the\s+@usernames/);
  });

  it('teaches personal quiet hours: mute/unmute, MSK default, «меня» → sender username', () => {
    expect(SYSTEM_PROMPT).toContain('PERSONAL QUIET');
    expect(SYSTEM_PROMPT).toContain('не тегай меня до');
    expect(SYSTEM_PROMPT).toContain('Europe/Moscow');
    expect(SYSTEM_PROMPT).toMatch(/«меня»[\s\S]*?@username/);
  });

  it('teaches append vs replace for quiet-hours edits, defaulting to the safe append', () => {
    expect(SYSTEM_PROMPT).toContain('APPEND vs REPLACE');
    // Additive phrasing keeps old windows; restatements rewrite; unsure → false.
    expect(SYSTEM_PROMPT).toMatch(/ещё\s+не тегай в субботу/);
    expect(SYSTEM_PROMPT).toContain('`replace`: true');
    expect(SYSTEM_PROMPT).toMatch(/Unsure => false/);
  });

  it('forbids inventing @usernames and teaches the ask-for-a-reply fallback', () => {
    expect(SYSTEM_PROMPT).toContain('NEVER INVENT @usernames');
    // Cyrillic handles are called out as fabrications that ping nobody.
    expect(SYSTEM_PROMPT).toMatch(/Cyrillic[\s\S]*?fabrication/);
    // The fallback: ask once and suggest the person reply so the handle surfaces.
    expect(SYSTEM_PROMPT).toMatch(/реплаем/);
  });

  it('teaches the mention-rename flow that preserves quiet hours', () => {
    expect(SYSTEM_PROMPT).toContain('исправь меншн');
    expect(SYSTEM_PROMPT).toContain('`rename`');
    expect(SYSTEM_PROMPT).toContain('renameTo');
    // remove+add would drop the mute schedule — explicitly banned.
    expect(SYSTEM_PROMPT).toMatch(/never do it as remove\+add/);
  });
});

describe('buildContextBlock sender username', () => {
  const base = {
    defaultCurrency: 'EUR',
    members: [],
    senderName: 'Вася',
    timezone: null,
    splidConnected: false,
  };

  it('exposes the sender @username for tool inputs when present', () => {
    const out = buildContextBlock({ ...base, senderUsername: 'vasya_mid' });
    expect(out).toContain('Message sender: Вася');
    expect(out).toContain('@vasya_mid');
  });

  it('renders the plain sender line when there is no username', () => {
    const out = buildContextBlock(base);
    expect(out).toContain('Message sender: Вася');
    expect(out).not.toContain('username for tool inputs');
  });
});

describe('buildTutorContextBlock', () => {
  it('keeps time/timezone/sender/memory and drops the Splid-flavoured lines', async () => {
    const { buildTutorContextBlock } = await import('../src/llm/prompts.js');
    const block = buildTutorContextBlock({
      senderName: 'Мелкий',
      timezone: 'Europe/Moscow',
      activeReminders: [{ id: 3, title: 'решать задачи', when: 'завтра 19:00' }],
      memoryChat: [{ content: 'экзамен по физике 5 июня' }],
      memoryUsers: [{ subject: 'Мелкий', items: [{ content: 'хромает на проценты' }] }],
    });
    expect(block).toContain('Current time (UTC):');
    expect(block).toContain('Chat timezone: Europe/Moscow');
    expect(block).toContain('Message sender (the student): Мелкий');
    expect(block).toContain('#3 «решать задачи»');
    expect(block).toContain('экзамен по физике 5 июня');
    expect(block).toContain('About Мелкий');
    // No secretary context leaks into the study room.
    expect(block).not.toContain('Splid');
    expect(block).not.toContain('Group members');
    expect(block).not.toContain('currency');
    expect(block).not.toContain('Saved places');
  });
});
