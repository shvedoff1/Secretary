import { loadConfig } from '../config.js';
import { logger } from '../logger.js';

// Dota 2 reference data. This is the ONLY place dota2.com / dotaconstants HTTP
// happens — same rule as splid-js under providers/splid and Open-Meteo under
// src/surf/openMeteo.ts.
//
// Two sources, because neither is complete on its own:
//  • www.dota2.com/datafeed — Valve's own, undocumented but keyless, always on
//    the live patch. Authoritative for heroes, items, abilities, patch notes.
//    Quirks found the hard way: ids can NOT be batched (`item_id=1,2,3` returns
//    one item), `language=russian` localises descriptions but NOT names, and
//    `facets` comes back empty for every hero.
//  • odota/dotaconstants (raw GitHub JSON, MIT) — fills exactly the two gaps:
//    hero FACETS and TALENT values (the datafeed ships talents as unresolved
//    `{s:bonus_x}` templates with an empty special_values list). It is rebuilt
//    per patch by a third party, so it may lag — cards label it as such.
//
// Undocumented means "be polite, not "hammer it": every request goes through a
// shared minimum-gap gate, so a full ~550-request crawl paces itself no matter
// how the caller loops.

const DATAFEED = 'https://www.dota2.com/datafeed';
const CONSTANTS = 'https://raw.githubusercontent.com/odota/dotaconstants/master/build';

const MAX_ATTEMPTS = 3;

export interface FeedSpecialValue {
  name: string;
  values_float?: number[];
  is_percentage?: boolean;
  heading_loc?: string;
  values_shard?: number[];
  values_scepter?: number[];
}

/** An ability, a talent and an item all share this shape in the datafeed. */
export interface FeedAbility {
  id: number;
  name: string;
  name_loc: string;
  desc_loc?: string;
  lore_loc?: string;
  notes_loc?: string[];
  shard_loc?: string;
  scepter_loc?: string;
  type?: number;
  behavior?: string;
  max_level?: number;
  cast_ranges?: number[];
  cast_points?: number[];
  channel_times?: number[];
  cooldowns?: number[];
  durations?: number[];
  damages?: number[];
  mana_costs?: number[];
  special_values?: FeedSpecialValue[];
}

export interface FeedItem extends FeedAbility {
  is_item?: boolean;
  item_cost?: number;
  item_quality?: number | string;
  item_neutral_tier?: number;
  item_initial_charges?: number;
  item_stock_max?: number;
  item_stock_time?: number;
}

export interface FeedHero {
  id: number;
  name: string;
  name_loc: string;
  primary_attr?: number;
  complexity?: number;
  str_base?: number;
  str_gain?: number;
  agi_base?: number;
  agi_gain?: number;
  int_base?: number;
  int_gain?: number;
  max_health?: number;
  max_mana?: number;
  health_regen?: number;
  mana_regen?: number;
  armor?: number;
  magic_resistance?: number;
  damage_min?: number;
  damage_max?: number;
  attack_rate?: number;
  attack_range?: number;
  attack_capability?: number;
  movement_speed?: number;
  turn_rate?: number;
  sight_range_day?: number;
  sight_range_night?: number;
  role_levels?: number[];
  bio_loc?: string;
  hype_loc?: string;
  abilities?: FeedAbility[];
  talents?: FeedAbility[];
}

export interface FeedListEntry {
  id: number;
  name: string;
  name_loc: string;
  name_english_loc?: string;
  neutral_item_tier?: number;
  primary_attr?: number;
  complexity?: number;
}

export interface FeedPatch {
  patch_number: string;
  patch_name: string;
  patch_timestamp: number;
}

export interface FeedPatchNote {
  note?: string;
  indent_level?: number;
}

export interface FeedPatchNotes {
  patch_number: string;
  patch_name: string;
  patch_timestamp: number;
  general_notes?: { title?: string; generic?: FeedPatchNote[] }[];
  items?: { ability_id: number; ability_notes?: FeedPatchNote[] }[];
  neutral_items?: {
    ability_id: number;
    title?: string;
    is_general_note?: boolean;
    ability_notes?: FeedPatchNote[];
  }[];
  heroes?: {
    hero_id: number;
    hero_notes?: FeedPatchNote[];
    talent_notes?: FeedPatchNote[];
    abilities?: { ability_id: number; ability_notes?: FeedPatchNote[] }[];
  }[];
}

/** The two dotaconstants files we need, already narrowed to what we use. */
export interface ConstantsData {
  /** hero key (npc_dota_hero_x) → facets + talent names. */
  heroAbilities: Record<
    string,
    {
      facets?: { name?: string; title?: string; description?: string; deprecated?: string }[];
      talents?: { name: string; level?: number }[];
    }
  >;
  /** ability/talent key → resolved English display name ("-12s Healing Ward Cooldown"). */
  abilities: Record<string, { dname?: string }>;
}

let lastRequestAt = 0;

/**
 * Serialise politeness: never issue two requests closer than the configured gap.
 *
 * The slot is reserved SYNCHRONOUSLY, before the await — concurrent callers
 * (fetchConstants fires two requests at once) would otherwise both measure their
 * wait against the same `lastRequestAt` and fire together, which is the one
 * thing this gate exists to prevent.
 */
async function politeGap(): Promise<void> {
  const gap = loadConfig().DOTA_FEED_DELAY_MS;
  const now = Date.now();
  const slot = Math.max(now, lastRequestAt + gap);
  lastRequestAt = slot;
  const wait = slot - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

async function getJson<T>(url: string): Promise<T> {
  const cfg = loadConfig();
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await politeGap();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.DOTA_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          // A contactable UA is the courteous thing on an undocumented endpoint.
          'User-Agent': 'SecretaryBot/1.0 (Telegram assistant; Dota reference sync)',
          Accept: 'application/json',
        },
      });
      // 429 / 5xx are worth another go; a 404 is a fact, not a hiccup.
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status}`);
      }
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { fatal: true });
      return (await res.json()) as T;
    } catch (err) {
      lastErr = err;
      if ((err as { fatal?: boolean }).fatal || attempt === MAX_ATTEMPTS) break;
      await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`dota feed request failed: ${url} (${String(lastErr)})`);
}

function lang(): string {
  return loadConfig().DOTA_LANGUAGE;
}

export async function fetchHeroList(): Promise<FeedListEntry[]> {
  const d = await getJson<{ result?: { data?: { heroes?: FeedListEntry[] } } }>(
    `${DATAFEED}/herolist?language=${lang()}`,
  );
  return d.result?.data?.heroes ?? [];
}

export async function fetchHero(id: number): Promise<FeedHero | null> {
  const d = await getJson<{ result?: { data?: { heroes?: FeedHero[] } } }>(
    `${DATAFEED}/herodata?hero_id=${id}&language=${lang()}`,
  );
  return d.result?.data?.heroes?.[0] ?? null;
}

/** The item list also carries recipes and neutral items; callers filter. */
export async function fetchItemList(): Promise<FeedListEntry[]> {
  const d = await getJson<{ result?: { data?: { itemabilities?: FeedListEntry[] } } }>(
    `${DATAFEED}/itemlist?language=${lang()}`,
  );
  return d.result?.data?.itemabilities ?? [];
}

export async function fetchItem(id: number): Promise<FeedItem | null> {
  const d = await getJson<{ result?: { data?: { items?: FeedItem[] } } }>(
    `${DATAFEED}/itemdata?item_id=${id}&language=${lang()}`,
  );
  return d.result?.data?.items?.[0] ?? null;
}

/** Cheapest call in the file (~9KB) — this is the "did the patch change?" probe. */
export async function fetchPatchList(): Promise<FeedPatch[]> {
  const d = await getJson<{ patches?: FeedPatch[] }>(`${DATAFEED}/patchnoteslist`);
  return d.patches ?? [];
}

export async function fetchPatchNotes(version: string): Promise<FeedPatchNotes | null> {
  const d = await getJson<FeedPatchNotes & { success?: boolean }>(
    `${DATAFEED}/patchnotes?version=${encodeURIComponent(version)}&language=${lang()}`,
  );
  return d.patch_number ? d : null;
}

/**
 * Facets + talent values from dotaconstants. Best-effort: this is a supplement,
 * so a GitHub hiccup degrades the cards (no facets, templated talents) instead
 * of failing the whole sync.
 */
export async function fetchConstants(): Promise<ConstantsData> {
  const empty: ConstantsData = { heroAbilities: {}, abilities: {} };
  try {
    const [heroAbilities, abilities] = await Promise.all([
      getJson<ConstantsData['heroAbilities']>(`${CONSTANTS}/hero_abilities.json`),
      getJson<ConstantsData['abilities']>(`${CONSTANTS}/abilities.json`),
    ]);
    return { heroAbilities, abilities };
  } catch (err) {
    logger.warn({ err }, 'dotaconstants fetch failed — cards lose facets/talent values');
    return empty;
  }
}
