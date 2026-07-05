import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

async function freshRepo() {
  process.env.BOT_TOKEN = 'x';
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.ADMIN_TELEGRAM_ID = '1';
  process.env.DATABASE_PATH = ':memory:';
  vi.resetModules();
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
  return import('../src/db/repos/memoryItem.repo.js');
}

let closeDb: () => void;
afterEach(async () => {
  if (closeDb) closeDb();
});
beforeEach(async () => {
  ({ closeDb } = await import('../src/db/client.js'));
});

describe('memory sample buffer', () => {
  it('round-trips samples and preserves the sender', async () => {
    const repo = await freshRepo();
    repo.recordSample(1, 100, 'Sky', 'привет');
    repo.recordSample(1, 200, 'Max', 'ку');
    expect(repo.sampleStats(1).count).toBe(2);

    const claimed = repo.claimSamples(1);
    expect(claimed).toEqual([
      { tgUserId: 100, senderName: 'Sky', content: 'привет' },
      { tgUserId: 200, senderName: 'Max', content: 'ку' },
    ]);
    // Claiming deletes them.
    expect(repo.sampleStats(1).count).toBe(0);
  });
});

describe('memory store', () => {
  it('records passive items and clamps importance', async () => {
    const repo = await freshRepo();
    repo.recordMemoryItems(1, [
      { scope: 'user', tgUserId: 100, subject: 'Sky', content: 'любит серф', importance: 99 },
      { scope: 'chat', tgUserId: null, subject: '', content: 'едут на Бали', importance: 4 },
      { scope: 'chat', tgUserId: null, subject: '', content: '   ', importance: 3 },
    ]);
    const items = repo.getAllItems(1);
    expect(items).toHaveLength(2); // blank content skipped
    const sky = items.find((i) => i.content === 'любит серф')!;
    expect(sky.importance).toBe(5); // clamped from 99
    expect(sky.source).toBe('passive');
  });

  it('reinforces an item: bumps count, importance and last_seen', async () => {
    const repo = await freshRepo();
    repo.recordMemoryItems(1, [
      { scope: 'chat', tgUserId: null, subject: '', content: 'факт', importance: 3 },
    ]);
    const before = repo.getAllItems(1)[0]!;
    repo.reinforceItems(1, [before.id]);
    const after = repo.getAllItems(1)[0]!;
    expect(after.reinforce).toBe(1);
    expect(after.importance).toBeCloseTo(3.5, 6);
    expect(after.lastSeen).toBeGreaterThanOrEqual(before.lastSeen);
  });

  it('caps importance via reinforcement at 5', async () => {
    const repo = await freshRepo();
    repo.recordMemoryItems(1, [
      { scope: 'chat', tgUserId: null, subject: '', content: 'факт', importance: 5 },
    ]);
    const id = repo.getAllItems(1)[0]!.id;
    repo.reinforceItems(1, [id]);
    repo.reinforceItems(1, [id]);
    expect(repo.getAllItems(1)[0]!.importance).toBe(5);
  });

  it('pins explicit items, exempt from pruning', async () => {
    const repo = await freshRepo();
    repo.insertPinned(1, 'закреплённый факт');
    repo.recordMemoryItems(1, [
      { scope: 'chat', tgUserId: null, subject: '', content: 'p-high', importance: 5 },
      { scope: 'chat', tgUserId: null, subject: '', content: 'p-low', importance: 1 },
    ]);

    // Cap passive at 1 → the lower-weight passive item is pruned; pinned survives.
    repo.pruneMemory(1, 1, 14);
    const contents = repo.getAllItems(1).map((i) => i.content).sort();
    expect(contents).toEqual(['p-high', 'закреплённый факт']);
  });

  it('lists items for display pinned-first then by weight, and removes by id', async () => {
    const repo = await freshRepo();
    repo.recordMemoryItems(1, [
      { scope: 'chat', tgUserId: null, subject: '', content: 'low', importance: 1 },
      { scope: 'chat', tgUserId: null, subject: '', content: 'high', importance: 5 },
    ]);
    repo.insertPinned(1, 'pinned');

    const display = repo.listMemoryItemsForDisplay(1, 14);
    expect(display[0]).toMatchObject({ content: 'pinned', pinned: true });
    expect(display.slice(1).map((d) => d.content)).toEqual(['high', 'low']);

    const removed = repo.removeMemoryItem(1, display[1]!.id);
    expect(removed).toBe('high');
    expect(repo.getAllItems(1).map((i) => i.content).sort()).toEqual(['low', 'pinned']);
  });

  it('applies a reconcile plan: edits survivors, deletes the rest, skips foreign ids', async () => {
    const repo = await freshRepo();
    const a = repo.insertPinned(1, 'Миша и Михалыч разные люди');
    const b = repo.insertPinned(1, 'Миша это Михалыч, один человек');
    const c = repo.insertPinned(1, 'едут на Бали');
    // Plan: rewrite A to the resolved wording, delete B (contradiction), delete a
    // foreign id (no-op), and delete C's id which is ALSO edited → the edit wins.
    const res = repo.applyReconcilePlan(1, {
      edits: [
        { id: a, content: 'Миша = Михалыч — один человек' },
        { id: c, content: 'едут на Бали ради серфинга' },
      ],
      deletes: [{ id: b }, { id: 99999 }, { id: c }],
    });
    expect(res).toEqual({ edited: 2, deleted: 1 }); // only B deleted; foreign + edited-c skipped
    const contents = repo.getAllItems(1).map((i) => i.content).sort();
    expect(contents).toEqual(['Миша = Михалыч — один человек', 'едут на Бали ради серфинга']);
  });

  it('clears all items and buffered samples for a chat', async () => {
    const repo = await freshRepo();
    repo.insertPinned(1, 'x');
    repo.recordSample(1, 100, 'Sky', 'y');
    repo.clearMemoryItems(1);
    expect(repo.getAllItems(1)).toEqual([]);
    expect(repo.sampleStats(1).count).toBe(0);
  });

  it('drops expense-like passive facts (money belongs in Splid, not memory)', async () => {
    const repo = await freshRepo();
    repo.recordMemoryItems(1, [
      { scope: 'chat', tgUserId: null, subject: '', content: 'едут на Бали', importance: 4 },
      {
        scope: 'chat',
        tgUserId: null,
        subject: '',
        content: 'Расход на кофе 260 тыс, платил Антон, делится пополам',
        importance: 4,
      },
    ]);
    expect(repo.getAllItems(1).map((i) => i.content)).toEqual(['едут на Бали']);
  });

  it('folds a restated passive fact into a reinforce instead of duplicating', async () => {
    const repo = await freshRepo();
    repo.recordMemoryItems(1, [
      { scope: 'chat', tgUserId: null, subject: '', content: 'Миша — это Михалыч', importance: 3 },
    ]);
    // A later batch restates the same fact with different casing/punctuation.
    repo.recordMemoryItems(1, [
      { scope: 'chat', tgUserId: null, subject: '', content: 'миша это михалыч.', importance: 3 },
    ]);
    const items = repo.getAllItems(1);
    expect(items).toHaveLength(1);
    expect(items[0]!.reinforce).toBe(1);
  });

  it('re-pinning an existing (even passive) fact promotes it, never duplicates', async () => {
    const repo = await freshRepo();
    repo.recordMemoryItems(1, [
      { scope: 'chat', tgUserId: null, subject: '', content: 'любит серф', importance: 2 },
    ]);
    const passiveId = repo.getAllItems(1)[0]!.id;
    const pinnedId = repo.insertPinned(1, 'Любит серф!');
    expect(pinnedId).toBe(passiveId); // same row
    const items = repo.getAllItems(1);
    expect(items).toHaveLength(1);
    expect(items[0]!.source).toBe('explicit'); // promoted to pinned
  });

  it('reclassifies an item into the persona bucket (pinned, unattributed)', async () => {
    const repo = await freshRepo();
    repo.recordMemoryItems(1, [
      { scope: 'user', tgUserId: 5, subject: 'Sky', content: 'говори как серфер', importance: 3 },
    ]);
    const id = repo.getAllItems(1)[0]!.id;
    const moved = repo.setItemScope(1, id, 'persona');
    expect(moved).toBe('говори как серфер');
    const it = repo.getAllItems(1)[0]!;
    expect(it.scope).toBe('persona');
    expect(it.source).toBe('explicit');
    expect(it.tgUserId).toBeNull();
    // Persona items ride their own context section, not the chat facts.
    const sel = repo.getMemoryForContext(1, {
      senderTgUserId: 5,
      recentParticipantIds: [5],
      halfLifeDays: 14,
      chatBudget: 8,
      userBudget: 6,
    });
    expect(sel.persona.map((i) => i.content)).toEqual(['говори как серфер']);
    expect(sel.chat).toHaveLength(0);
  });

  it('dedupeMemory folds duplicates into the strongest survivor', async () => {
    const repo = await freshRepo();
    // Two passive dupes plus a pinned dupe of the same fact.
    repo.recordMemoryItems(1, [
      { scope: 'chat', tgUserId: null, subject: '', content: 'уникальный факт', importance: 3 },
    ]);
    // Bypass insert-time dedup by writing raw dupes via the pinned path with distinct
    // punctuation is folded on insert, so craft dupes that only collide after
    // normalization but were stored before dedup existed: use recordMemoryItems for
    // one and a direct second insert with different surface form.
    const db = (await import('../src/db/client.js')).getDb();
    db.prepare(
      `INSERT INTO chat_memory_item
         (chat_id, scope, tg_user_id, subject, content, importance, reinforce, source, created_at, last_seen)
       VALUES (1,'chat',NULL,'','Уникальный факт!',3,0,'passive',1,1)`,
    ).run();
    db.prepare(
      `INSERT INTO chat_memory_item
         (chat_id, scope, tg_user_id, subject, content, importance, reinforce, source, created_at, last_seen)
       VALUES (1,'chat',NULL,'','уникальный   факт',3,2,'explicit',1,1)`,
    ).run();
    expect(repo.getAllItems(1)).toHaveLength(3);

    const removed = repo.dedupeMemory(1, 14);
    expect(removed).toBe(2);
    const survivors = repo.getAllItems(1);
    expect(survivors).toHaveLength(1);
    // The pinned row wins; it absorbs the folded rows' reinforcement (2 + 1 + 1 = 4).
    expect(survivors[0]!.source).toBe('explicit');
    expect(survivors[0]!.reinforce).toBe(4);
  });

  it('finds a fact by text forgivingly and refuses ambiguous matches', async () => {
    const repo = await freshRepo();
    repo.insertPinned(1, 'Итого 5 человек: Шведский, Антоха, Иванес, Миша, Михалыч');
    repo.insertPinned(1, 'Едут на Бали ради серфинга');
    // Exact-ish (casing/punctuation-insensitive) and containment both resolve.
    expect(repo.findMemoryItemByText(1, 'итого 5 человек')!.content).toContain('Итого 5');
    expect(repo.findMemoryItemByText(1, 'бали ради серфинга')!.content).toContain('Бали');
    // No match → null.
    expect(repo.findMemoryItemByText(1, 'совершенно другое')).toBeNull();
    // Ambiguous containment → null (never guesses).
    repo.insertPinned(1, 'серфинг утром');
    expect(repo.findMemoryItemByText(1, 'серфинг')).toBeNull();
  });

  it('does not let an emoji/punctuation-only fact act as a match-everything wildcard', async () => {
    const repo = await freshRepo();
    repo.insertPinned(1, '🤙'); // normalizes to empty
    repo.insertPinned(1, 'Итого 5 человек');
    // A query that matches no real fact must NOT resolve to the empty-normalized fact.
    expect(repo.findMemoryItemByText(1, 'совершенно левый текст')).toBeNull();
    // Real matches still work with the wildcard fact present.
    expect(repo.findMemoryItemByText(1, 'итого 5 человек')!.content).toBe('Итого 5 человек');
  });

  it('folds an edit that would duplicate another fact instead of creating a twin', async () => {
    const repo = await freshRepo();
    const a = repo.insertPinned(1, 'Едем на Бали');
    const b = repo.insertPinned(1, 'Летим на Бали');
    // Correcting B to equal A must not leave two identical rows (which would be
    // un-findable by the tools, exact.length > 1 → null).
    const old = repo.editMemoryItemContent(1, b, 'едем на бали');
    expect(old).toBe('Летим на Бали');
    const items = repo.getAllItems(1);
    expect(items).toHaveLength(1); // B folded into A
    expect(items[0]!.id).toBe(a);
    expect(items[0]!.reinforce).toBe(1); // survivor absorbed the fold
    // And the text stays findable (single row now).
    expect(repo.findMemoryItemByText(1, 'Едем на Бали')!.id).toBe(a);
  });

  it('edits a fact in place, keeping its id and reinforcement history', async () => {
    const repo = await freshRepo();
    const id = repo.insertPinned(1, 'Итого 5 человек');
    repo.reinforceItems(1, [id]);
    const old = repo.editMemoryItemContent(1, id, 'Итого 4 человека');
    expect(old).toBe('Итого 5 человек');
    const it = repo.getAllItems(1)[0]!;
    expect(it.id).toBe(id); // same row
    expect(it.content).toBe('Итого 4 человека');
    expect(it.reinforce).toBe(1); // history preserved
    expect(repo.editMemoryItemContent(1, 9999, 'x')).toBeNull();
  });

  it('injects pinned chat facts beyond the passive budget', async () => {
    const repo = await freshRepo();
    for (let i = 0; i < 12; i++) repo.insertPinned(1, `закреплённый факт ${i}`);
    const sel = repo.getMemoryForContext(1, {
      senderTgUserId: 100,
      recentParticipantIds: [],
      halfLifeDays: 14,
      chatBudget: 8, // passive budget — must NOT cap pinned facts
      userBudget: 6,
    });
    expect(sel.chat).toHaveLength(12); // all pinned survive
  });

  it('builds a context selection split into chat and per-user sections', async () => {
    const repo = await freshRepo();
    repo.recordMemoryItems(1, [
      { scope: 'chat', tgUserId: null, subject: '', content: 'общий', importance: 5 },
      { scope: 'user', tgUserId: 100, subject: 'Sky', content: 'про меня', importance: 5 },
      { scope: 'user', tgUserId: 200, subject: 'Max', content: 'про макса', importance: 4 },
    ]);
    const sel = repo.getMemoryForContext(1, {
      senderTgUserId: 100,
      recentParticipantIds: [100, 200],
      halfLifeDays: 14,
      chatBudget: 8,
      userBudget: 6,
    });
    expect(sel.chat.map((i) => i.content)).toEqual(['общий']);
    expect(sel.users[0]!.tgUserId).toBe(100);
    expect(sel.users.map((u) => u.tgUserId)).toContain(200);
  });
});
