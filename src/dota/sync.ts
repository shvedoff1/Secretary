import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import {
  countDotaEntities,
  getDotaSyncState,
  replaceDotaEntities,
  setDotaSyncState,
  type DotaEntityInput,
  type DotaSyncState,
} from '../db/repos/dota.repo.js';
import {
  fetchConstants,
  fetchHero,
  fetchHeroList,
  fetchItem,
  fetchItemList,
  fetchPatchList,
  fetchPatchNotes,
} from './feed.js';
import {
  renderGeneralPatchCard,
  renderHeroCard,
  renderItemCard,
  renderPatchCard,
} from './card.js';

// The nightly rebuild of the Dota knowledge base.
//
// A full crawl is ~550 requests (ids cannot be batched), so it runs at most once
// a day, at night, and only when something actually changed: the first thing it
// does is one 9KB `patchnoteslist` request, and if the top patch still matches
// what the DB holds the crawl is skipped entirely. A staleness net forces a
// rebuild anyway every few days in case a hotfix ships under an unchanged
// version string.

export interface SyncOptions {
  hourUtc: number;
  minIntervalHours: number;
  maxAgeHours: number;
}

/**
 * Should the hourly tick start a sync? Pure so the schedule is testable without
 * a clock or a network.
 *
 * - no data at all => yes, right now (a bot that just booted must not wait for
 *   3am to be able to answer anything);
 * - already probed within the last interval => no (one probe a day);
 * - data older than the staleness net => yes, whatever the hour;
 * - otherwise only during the configured night hour.
 */
export function isSyncDue(state: DotaSyncState, now: number, opts: SyncOptions): boolean {
  if (!state.lastFullSync) return true;
  const hour = 3_600_000;
  if (state.lastCheck && now - state.lastCheck < opts.minIntervalHours * hour) return false;
  if (now - state.lastFullSync >= opts.maxAgeHours * hour) return true;
  return new Date(now).getUTCHours() === opts.hourUtc;
}

export interface SyncResult {
  status: 'synced' | 'up-to-date' | 'skipped' | 'failed';
  patch?: string;
  counts?: { hero: number; item: number; patch: number };
  error?: string;
}

// Recipes are not real items (no description, no stats) and would only pad the
// index; neutral items and consumables stay.
function isRealItem(name: string, nameLoc: string): boolean {
  return !name.startsWith('item_recipe') && nameLoc.trim().length > 0;
}

async function crawl(patch: string): Promise<DotaEntityInput[]> {
  const entities: DotaEntityInput[] = [];
  const constants = await fetchConstants();

  const heroList = await fetchHeroList();
  // Ability id -> display name, harvested while crawling heroes: the patch notes
  // reference abilities by id only, and building this from the heroes we already
  // fetch saves a separate 750KB abilitylist request.
  const abilityNames = new Map<number, string>();
  const heroNames = new Map<number, string>();
  let heroFailures = 0;

  for (const entry of heroList) {
    try {
      const hero = await fetchHero(entry.id);
      if (!hero) {
        heroFailures++;
        continue;
      }
      heroNames.set(hero.id, hero.name_loc);
      for (const ability of hero.abilities ?? []) abilityNames.set(ability.id, ability.name_loc);
      const rendered = renderHeroCard(hero, constants, patch);
      entities.push({ ...rendered, kind: 'hero', key: hero.name, feedId: hero.id, name: hero.name_loc });
    } catch (err) {
      heroFailures++;
      logger.warn({ err, heroId: entry.id }, 'dota hero fetch failed');
    }
  }
  logger.info({ heroes: entities.length, heroFailures }, 'dota sync: heroes done');

  const itemList = (await fetchItemList()).filter((i) => isRealItem(i.name, i.name_loc));
  const itemNames = new Map<number, string>();
  let itemFailures = 0;
  for (const entry of itemList) {
    try {
      const item = await fetchItem(entry.id);
      if (!item) {
        itemFailures++;
        continue;
      }
      itemNames.set(item.id, item.name_loc);
      const rendered = renderItemCard(item, patch);
      entities.push({ ...rendered, kind: 'item', key: item.name, feedId: item.id, name: item.name_loc });
    } catch (err) {
      itemFailures++;
      logger.warn({ err, itemId: entry.id }, 'dota item fetch failed');
    }
  }
  logger.info({ items: itemList.length - itemFailures, itemFailures }, 'dota sync: items done');

  // A crawl that lost a big chunk of the game is worse than yesterday's data —
  // refuse it rather than replacing a good KB with a gutted one.
  const heroLoss = heroList.length > 0 ? heroFailures / heroList.length : 1;
  const itemLoss = itemList.length > 0 ? itemFailures / itemList.length : 1;
  if (heroLoss > 0.2 || itemLoss > 0.2) {
    throw new Error(
      `too many feed failures (heroes ${heroFailures}/${heroList.length}, items ${itemFailures}/${itemList.length})`,
    );
  }

  const notes = await fetchPatchNotes(patch);
  if (notes) {
    for (const hero of notes.heroes ?? []) {
      const name = heroNames.get(hero.hero_id);
      if (!name) continue;
      const card = renderPatchCard(name, patch, hero.hero_notes, [
        { title: 'Таланты', notes: hero.talent_notes },
        ...(hero.abilities ?? []).map((a) => ({
          title: abilityNames.get(a.ability_id) ?? `Способность #${a.ability_id}`,
          notes: a.ability_notes,
        })),
      ]);
      if (card) entities.push({ ...card, kind: 'patch', key: `patch:hero:${name}`, name });
    }
    for (const item of [...(notes.items ?? []), ...(notes.neutral_items ?? [])]) {
      const name = itemNames.get(item.ability_id);
      if (!name) continue;
      const card = renderPatchCard(name, patch, item.ability_notes);
      if (card) entities.push({ ...card, kind: 'patch', key: `patch:item:${name}`, name });
    }
    const general = renderGeneralPatchCard(notes);
    if (general) {
      entities.push({
        ...general,
        kind: 'patch',
        key: 'patch:general',
        name: `Патч ${patch}`,
      });
    }
  }

  return entities;
}

let running = false;

/**
 * Run a sync if one is due (or if `force`). Single-flighted: the hourly tick and
 * the admin's `/dota sync` can never crawl at the same time.
 */
export async function runDotaSync(force = false): Promise<SyncResult> {
  const cfg = loadConfig();
  if (!cfg.ENABLE_DOTA) return { status: 'skipped' };
  if (running) return { status: 'skipped', error: 'синк уже идёт' };

  const state = getDotaSyncState();
  const now = Date.now();
  const opts: SyncOptions = {
    hourUtc: cfg.DOTA_SYNC_HOUR_UTC,
    minIntervalHours: cfg.DOTA_SYNC_MIN_INTERVAL_HOURS,
    maxAgeHours: cfg.DOTA_SYNC_MAX_AGE_HOURS,
  };
  if (!force && !isSyncDue(state, now, opts)) return { status: 'skipped' };

  running = true;
  const started = Date.now();
  try {
    setDotaSyncState({ lastCheck: now });

    const patches = await fetchPatchList();
    const latest = patches[patches.length - 1]?.patch_number;
    if (!latest) throw new Error('patch list came back empty');

    const counts = countDotaEntities();
    const hasData = counts.hero > 0 && counts.item > 0;
    const stale =
      !state.lastFullSync || now - state.lastFullSync >= opts.maxAgeHours * 3_600_000;
    if (!force && hasData && state.patch === latest && !stale) {
      logger.info({ patch: latest }, 'dota sync: patch unchanged, skipping crawl');
      setDotaSyncState({ lastError: null });
      return { status: 'up-to-date', patch: latest, counts };
    }

    logger.info({ patch: latest, previous: state.patch }, 'dota sync: crawling');
    const entities = await crawl(latest);
    replaceDotaEntities(entities, latest);
    setDotaSyncState({
      patch: latest,
      lastFullSync: Date.now(),
      lastCheck: Date.now(),
      lastError: null,
    });
    const after = countDotaEntities();
    logger.info(
      { patch: latest, counts: after, seconds: Math.round((Date.now() - started) / 1000) },
      'dota sync: done',
    );
    return { status: 'synced', patch: latest, counts: after };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err }, 'dota sync failed');
    // The previous KB is untouched (the swap is one transaction), so a failed
    // sync degrades to "yesterday's patch", never to "no data".
    setDotaSyncState({ lastError: message });
    return { status: 'failed', error: message };
  } finally {
    running = false;
  }
}

/** Hourly tick entry point (see index.ts). Never throws. */
export async function runDueDotaSync(): Promise<void> {
  try {
    await runDotaSync(false);
  } catch (err) {
    logger.warn({ err }, 'dota sync tick failed');
  }
}
