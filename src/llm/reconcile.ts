import type Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { getAnthropic } from './client.js';
import { looksLikeExpense } from '../util/money.js';
import type { MemoryItem } from '../db/repos/memoryItem.repo.js';

/** A fact the pass proposes to drop (contradicted / stale / duplicate). */
export interface ReconcileDelete {
  id: number;
  reason: string;
}

/** A surviving fact the pass proposes to rewrite to a clean consolidated wording. */
export interface ReconcileEdit {
  id: number;
  content: string;
  reason: string;
}

/** The reconciliation plan: what to remove and what to rewrite. */
export interface ReconcilePlan {
  deletes: ReconcileDelete[];
  edits: ReconcileEdit[];
}

const EMPTY: ReconcilePlan = { deletes: [], edits: [] };

// One-shot cleanup of accumulated memory: unlike the extractor (which only ADDS and
// reinforces), this looks across the WHOLE store for facts that conflict or went stale
// and proposes removals/merges. Applied only after a human reviews the dry-run. Recorded
// expenses that leaked into memory are swept OUT deterministically (see withExpenseSweep)
// rather than left to the model's mood — money belongs in Splid, not memory.
const RECONCILE_SYSTEM = `You are cleaning a group chat's long-term memory. You get a numbered list of stored
facts, one per line as \`#id [who] text\` (📌 marks a fact a human pinned deliberately —
treat it as more authoritative and prefer keeping it).

Find ONLY these problems:
- CONTRADICTIONS: two or more facts that cannot all be true (e.g. "X and Y are the SAME
  person" vs "X and Y are DIFFERENT people"; an old status vs a newer opposite status).
  Keep the single most authoritative / most current-sounding one; delete the others.
- STALE / SUPERSEDED: a fact clearly replaced by a newer one about the same thing.
  Delete the outdated one.
- EXACT DUPLICATES: the same fact restated. Delete the extra copies, keep one.

List EVERY contradiction / stale / duplicate you are confident about — a human reviews
this dry-run before anything is applied, so be thorough, not shy. But do NOT delete a
fact merely for being trivial, unrelated, or one you dislike, and when you are not sure
two facts truly conflict, LEAVE THEM BOTH.

When merging a group, you MAY rewrite ONE surviving fact to a clean consolidated wording
via "edits", and delete the rest.

Output ONLY a JSON object (no prose, no markdown fences):
{"deletes":[{"id":12,"reason":"устарело: заменено #34"}],"edits":[{"id":7,"content":"итоговый факт","reason":"слил #7/#8"}]}
Keep "reason" short and in Russian. Never put the same id in both lists. If there is
nothing to clean, output {"deletes":[],"edits":[]}.`;

/**
 * Parse the model's reply into a reconciliation plan. Best-effort and defensive (the
 * model may wrap the object in prose/fences): grabs the outermost object, salvages each
 * entry independently, and yields an empty plan rather than throwing on bad output.
 */
export function parseReconcileJson(text: string, max = 100): ReconcilePlan {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return { ...EMPTY };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { ...EMPTY };
  }
  if (!parsed || typeof parsed !== 'object') return { ...EMPTY };

  const deletes: ReconcileDelete[] = [];
  const rawDeletes = (parsed as { deletes?: unknown }).deletes;
  if (Array.isArray(rawDeletes)) {
    for (const d of rawDeletes) {
      if (!d || typeof d !== 'object') continue;
      const id = Number((d as { id?: unknown }).id);
      if (!Number.isInteger(id) || id <= 0) continue;
      const reason = (d as { reason?: unknown }).reason;
      deletes.push({ id, reason: typeof reason === 'string' ? reason.trim() : '' });
      if (deletes.length >= max) break;
    }
  }

  const edits: ReconcileEdit[] = [];
  const rawEdits = (parsed as { edits?: unknown }).edits;
  if (Array.isArray(rawEdits)) {
    for (const e of rawEdits) {
      if (!e || typeof e !== 'object') continue;
      const id = Number((e as { id?: unknown }).id);
      const content = (e as { content?: unknown }).content;
      if (!Number.isInteger(id) || id <= 0) continue;
      if (typeof content !== 'string' || !content.trim()) continue;
      const reason = (e as { reason?: unknown }).reason;
      edits.push({ id, content: content.trim(), reason: typeof reason === 'string' ? reason.trim() : '' });
      if (edits.length >= max) break;
    }
  }

  // The model is told never to both edit and delete the same id; if it does anyway,
  // the edit wins (keep the consolidated survivor) and the stray delete is dropped.
  const editedIds = new Set(edits.map((e) => e.id));
  return { deletes: deletes.filter((d) => !editedIds.has(d.id)), edits };
}

/**
 * Add a DETERMINISTIC pass over the store for recorded expenses that leaked into memory
 * ("Расход на … платил … делится …") and mark every one for deletion — money belongs in
 * the provider, not memory. This runs regardless of the model's output (the LLM only
 * unreliably flags expenses since they aren't "contradictions"), so a `/reconcile` run
 * reliably clears the same expense lines every time. Skips ids already edited or deleted.
 */
export function withExpenseSweep(plan: ReconcilePlan, items: MemoryItem[]): ReconcilePlan {
  const claimed = new Set<number>([...plan.edits.map((e) => e.id), ...plan.deletes.map((d) => d.id)]);
  const extra: ReconcileDelete[] = [];
  for (const it of items) {
    if (claimed.has(it.id)) continue;
    if (looksLikeExpense(it.content)) {
      extra.push({ id: it.id, reason: 'трата — память не для трат, ей место в Splid' });
    }
  }
  return { deletes: [...plan.deletes, ...extra], edits: plan.edits };
}

/**
 * Run a one-shot reconciliation pass over a chat's whole memory using the cheap model.
 * Returns the proposed plan, or null if the model call failed (no key, API error) so the
 * caller can distinguish "nothing to clean" (empty plan) from "couldn't run".
 */
export async function reconcileMemory(items: MemoryItem[]): Promise<ReconcilePlan | null> {
  if (items.length === 0) return { ...EMPTY };
  const cfg = loadConfig();
  const rendered = items
    .map((i) => {
      const who = i.scope === 'user' ? i.subject || 'участник' : i.scope;
      const pin = i.source === 'explicit' ? ', 📌' : '';
      return `#${i.id} [${who}${pin}] ${i.content}`;
    })
    .join('\n');
  try {
    const res = await getAnthropic().messages.create({
      model: cfg.ANTHROPIC_MEMORY_MODEL,
      max_tokens: 2048,
      // Deterministic so re-running /reconcile on the same store proposes the same plan
      // instead of a different subset each time.
      temperature: 0,
      system: RECONCILE_SYSTEM,
      messages: [{ role: 'user', content: rendered }],
    });
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    // The LLM handles contradictions/stale/dupes; the expense sweep deterministically
    // clears any recorded-expense lines it left behind.
    return withExpenseSweep(parseReconcileJson(text), items);
  } catch (err) {
    logger.warn({ err }, 'memory reconciliation failed');
    return null;
  }
}
