import {
  formatNumber,
  formatValues,
  indexSpecialValues,
  renderText,
  type DotaSpecialValue,
} from './template.js';
import type {
  ConstantsData,
  FeedAbility,
  FeedHero,
  FeedItem,
  FeedPatchNote,
  FeedPatchNotes,
} from './feed.js';

// Pure renderers: feed JSON → the compact text card the assistant is handed by
// the dota_lookup tool. Everything here is deterministic and fixture-tested —
// no DB, no network — because a wrong number in a card is a wrong number in the
// chat, and that is the whole point of the feature.
//
// Cards are written in the feed language (Russian by default) with short Russian
// labels, since that is what the dota chat speaks. Hero/ability/item NAMES stay
// English: Valve does not localise them, and the chat says "Blink Dagger" anyway.

/** What the sync stores per entity. */
export interface DotaCard {
  /** Full card — everything known, used for a focused lookup. */
  card: string;
  /** One-or-two-line digest, used when several entities are asked for at once. */
  summary: string;
  /** Flattened text backing the FTS index. */
  search: string;
}

const ATTRS = ['сила', 'ловкость', 'интеллект', 'универсал'];
const ROLES = [
  'Carry',
  'Support',
  'Nuker',
  'Disabler',
  'Jungler',
  'Durable',
  'Escape',
  'Pusher',
  'Initiator',
];
const TALENT_LEVELS = [10, 15, 20, 25];

function join(parts: (string | null | undefined)[], sep = ' · '): string {
  return parts.filter((p): p is string => !!p && p.length > 0).join(sep);
}

/** Neutral tiers are 0..4; anything else means "not a neutral item". */
function isNeutralTier(tier: number | undefined): boolean {
  return tier != null && tier >= 0 && tier <= 4;
}

/** A per-level list that is all zeroes carries no information — drop it. */
function meaningful(values: readonly number[] | undefined): string | null {
  if (!values || values.length === 0) return null;
  if (values.every((v) => !v)) return null;
  return formatValues(values);
}

function notes(list: string[] | undefined, specials: Map<string, string>): string[] {
  return (list ?? [])
    .map((n) => renderText(n, specials))
    .filter((n) => n.length > 0);
}

/**
 * The `special_values` table doubles as the ability's stat block — each entry
 * carries the tooltip heading the game shows ("МАНА В СЕКУНДУ:"). Entries
 * without a heading are internal tuning knobs referenced by the description, so
 * they are already covered by the resolved text.
 */
function statLine(specials: readonly DotaSpecialValue[] | undefined): string | null {
  const parts: string[] = [];
  for (const sv of specials ?? []) {
    // Stat headings often arrive as an unlocalised key ("+$str", "+$damage") —
    // the client resolves those from a table the datafeed does not ship. Drop
    // the sigil rather than the line: "+str: 25" is still the right number with
    // the right label, while "+$str" reads like a broken template.
    const heading = (sv.heading_loc ?? '').replace(/\$/g, '').trim();
    if (!heading) continue;
    const value = formatValues(sv.values_float);
    if (value === null) continue;
    parts.push(`${heading.replace(/:$/, '')}: ${value}${sv.is_percentage ? '%' : ''}`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** Render one ability (also used for item actives — same shape in the feed). */
export function renderAbility(ability: FeedAbility, opts?: { compact?: boolean }): string {
  const specials = indexSpecialValues(ability.special_values);
  const meta = join([
    meaningful(ability.cooldowns) && `перезарядка ${meaningful(ability.cooldowns)} с`,
    meaningful(ability.mana_costs) && `мана ${meaningful(ability.mana_costs)}`,
    meaningful(ability.cast_ranges) && `дальность ${meaningful(ability.cast_ranges)}`,
    meaningful(ability.durations) && `длительность ${meaningful(ability.durations)} с`,
    meaningful(ability.damages) && `урон ${meaningful(ability.damages)}`,
  ]);

  const head = `${ability.name_loc} (${ability.name})${meta ? ` — ${meta}` : ''}`;
  const desc = renderText(ability.desc_loc ?? '', specials);
  if (opts?.compact) {
    const firstLine = desc.split('\n').filter(Boolean)[0] ?? '';
    return join([head, firstLine], ' — ');
  }

  const lines = [head];
  if (desc) lines.push(desc);
  const stats = statLine(ability.special_values);
  if (stats) lines.push(`Значения: ${stats}`);
  const note = notes(ability.notes_loc, specials);
  if (note.length > 0) lines.push(`Заметки: ${note.join(' ')}`);
  const scepter = renderText(ability.scepter_loc ?? '', specials);
  if (scepter) lines.push(`Aghanim's Scepter: ${scepter}`);
  const shard = renderText(ability.shard_loc ?? '', specials);
  if (shard) lines.push(`Aghanim's Shard: ${shard}`);
  return lines.join('\n');
}

function talentLines(hero: FeedHero, constants: ConstantsData): string[] {
  const talents = hero.talents ?? [];
  if (talents.length === 0) return [];
  const levels = constants.heroAbilities?.[hero.name]?.talents ?? [];
  const levelByName = new Map(levels.map((t) => [t.name, t.level]));

  const byLevel = new Map<number, string[]>();
  talents.forEach((talent, index) => {
    // dotaconstants resolves talent numbers ("-12s Healing Ward Cooldown"); the
    // datafeed ships the localised template with an EMPTY special_values list,
    // so the numbers simply are not in it. Prefer the resolved English name and
    // fall back to the template only when constants are unavailable.
    const dname = constants.abilities?.[talent.name]?.dname;
    // Both sources can leave a template behind: dotaconstants ships some dnames
    // with the placeholder intact ("+{s:bonus_damage} Meat Hook Damage"), and
    // the datafeed's localised name has no values at all. Sanitise either way,
    // so an unknown number reads as "?" instead of as quotable markup.
    const text = renderText(
      dname && dname.trim().length > 0 ? dname.trim() : talent.name_loc,
      talent.special_values,
    );
    // Talents come in level order, two per tier — the tier only comes from
    // constants, so infer it from the position when that is missing.
    const tier = levelByName.get(talent.name) ?? Math.floor(index / 2) + 1;
    const level = TALENT_LEVELS[Math.min(Math.max(tier, 1), TALENT_LEVELS.length) - 1]!;
    const bucket = byLevel.get(level) ?? [];
    bucket.push(text);
    byLevel.set(level, bucket);
  });

  return TALENT_LEVELS.filter((l) => byLevel.has(l)).map(
    (l) => `  ${l} ур.: ${(byLevel.get(l) ?? []).join(' | ')}`,
  );
}

function facetLines(hero: FeedHero, constants: ConstantsData): string[] {
  const facets = constants.heroAbilities?.[hero.name]?.facets ?? [];
  return facets
    .filter((f) => (f.title ?? '').trim().length > 0)
    // Facet descriptions are templated too, and their values ship nowhere we can
    // read — renderText turns the placeholders into "?" rather than leaking them.
    .map((f) => `  ${f.title}: ${renderText((f.description ?? '').trim())}`.trimEnd());
}

export function renderHeroCard(
  hero: FeedHero,
  constants: ConstantsData,
  patch: string,
): DotaCard {
  const attr = ATTRS[hero.primary_attr ?? 3] ?? 'универсал';
  const melee = hero.attack_capability === 1;
  const roles = (hero.role_levels ?? [])
    .map((level, i) => (level > 0 ? `${ROLES[i]} ${level}` : null))
    .filter((r): r is string => r !== null)
    .join(', ');

  const header = `Герой: ${hero.name_loc} (${hero.name}) — патч ${patch}`;
  const basics = join([
    `главный атрибут: ${attr}`,
    hero.complexity ? `сложность ${hero.complexity}/3` : null,
    melee ? 'ближний бой' : 'дальний бой',
    roles ? `роли: ${roles}` : null,
  ]);
  const stats = join([
    hero.str_base != null
      ? `СИЛ ${formatNumber(hero.str_base)}+${formatNumber(hero.str_gain ?? 0)}`
      : null,
    hero.agi_base != null
      ? `ЛОВ ${formatNumber(hero.agi_base)}+${formatNumber(hero.agi_gain ?? 0)}`
      : null,
    hero.int_base != null
      ? `ИНТ ${formatNumber(hero.int_base)}+${formatNumber(hero.int_gain ?? 0)}`
      : null,
  ]);
  const combat = join([
    hero.max_health != null ? `HP ${formatNumber(hero.max_health)}` : null,
    hero.max_mana != null ? `мана ${formatNumber(hero.max_mana)}` : null,
    hero.armor != null ? `броня ${formatNumber(hero.armor)}` : null,
    hero.damage_min != null ? `урон ${formatNumber(hero.damage_min)}-${formatNumber(hero.damage_max ?? hero.damage_min)}` : null,
    hero.movement_speed != null ? `скорость ${formatNumber(hero.movement_speed)}` : null,
    hero.attack_range ? `радиус атаки ${formatNumber(hero.attack_range)}` : null,
    hero.attack_rate ? `интервал атаки ${formatNumber(hero.attack_rate)}` : null,
  ]);

  const abilities = hero.abilities ?? [];
  const lines = [header, basics, stats, combat].filter((l) => l.length > 0);

  if (abilities.length > 0) {
    lines.push('Способности:');
    abilities.forEach((a, i) => {
      lines.push(
        `${i + 1}. ${renderAbility(a)
          .split('\n')
          .join('\n   ')}`,
      );
    });
  }

  const talents = talentLines(hero, constants);
  if (talents.length > 0) lines.push('Таланты:', ...talents);

  const facets = facetLines(hero, constants);
  if (facets.length > 0) {
    // Valve's datafeed returns facets:[] for every hero, so this half of the
    // card comes from a third-party mirror that can lag a patch. Say so rather
    // than letting the model present it as freshly official.
    lines.push('Грани (facets, источник dotaconstants — может отставать от патча):', ...facets);
  }

  const summary = join(
    [
      `${hero.name_loc} (${hero.name}) — патч ${patch}`,
      basics,
      abilities.length > 0
        ? `способности: ${abilities.map((a) => a.name_loc).join(', ')}`
        : null,
    ],
    '\n',
  );

  const search = join(
    [
      hero.name_loc,
      hero.name.replace(/^npc_dota_hero_/, '').replace(/_/g, ' '),
      abilities.map((a) => `${a.name_loc} ${a.name}`).join(' '),
      abilities.map((a) => renderText(a.desc_loc ?? '', a.special_values)).join(' '),
    ],
    ' ',
  );

  return { card: lines.join('\n'), summary, search };
}

export function renderItemCard(item: FeedItem, patch: string): DotaCard {
  const specials = indexSpecialValues(item.special_values);
  const header = `Предмет: ${item.name_loc} (${item.name}) — патч ${patch}`;
  const meta = join([
    item.item_cost ? `цена ${item.item_cost} золота` : 'не покупается',
    // "not a neutral item" comes back as -1, but the feed serialises it as an
    // unsigned int (4294967295) — so range-check instead of testing for >= 0.
    isNeutralTier(item.item_neutral_tier)
      ? `нейтральный предмет, тир ${item.item_neutral_tier! + 1}`
      : null,
    meaningful(item.cooldowns) && `перезарядка ${meaningful(item.cooldowns)} с`,
    meaningful(item.mana_costs) && `мана ${meaningful(item.mana_costs)}`,
    meaningful(item.cast_ranges) && `дальность ${meaningful(item.cast_ranges)}`,
    item.item_initial_charges ? `зарядов: ${item.item_initial_charges}` : null,
  ]);

  const desc = renderText(item.desc_loc ?? '', specials);
  const lines = [header, meta, desc].filter((l) => l.length > 0);

  const stats = statLine(item.special_values);
  if (stats) lines.push(`Значения: ${stats}`);
  const note = notes(item.notes_loc, specials);
  if (note.length > 0) lines.push(`Заметки: ${note.join(' ')}`);

  const firstLine = desc.split('\n').filter(Boolean)[0] ?? '';
  return {
    card: lines.join('\n'),
    summary: join([`${item.name_loc} (${item.name}) — патч ${patch}`, meta, firstLine], '\n'),
    search: join([item.name_loc, item.name.replace(/^item_/, '').replace(/_/g, ' '), desc], ' '),
  };
}

function noteLines(list: FeedPatchNote[] | undefined): string[] {
  return (list ?? [])
    .map((n) => (n.note ?? '').trim())
    .filter((n) => n.length > 0)
    .map((n) => `• ${n}`);
}

/**
 * Per-entity patch notes. `subjectNotes` are the top-level changes and
 * `groups` are the per-ability blocks (a hero's changes are split that way);
 * returns null when the patch says nothing about this entity.
 */
export function renderPatchCard(
  subject: string,
  patch: string,
  subjectNotes: FeedPatchNote[] | undefined,
  groups: { title: string; notes: FeedPatchNote[] | undefined }[] = [],
): DotaCard | null {
  const lines = [`Изменения в патче ${patch} — ${subject}:`];
  lines.push(...noteLines(subjectNotes));
  for (const group of groups) {
    const rendered = noteLines(group.notes);
    if (rendered.length === 0) continue;
    lines.push(`${group.title}:`, ...rendered.map((l) => `  ${l}`));
  }
  if (lines.length === 1) return null;
  const card = lines.join('\n');
  return { card, summary: card, search: `${subject} патч ${patch} ${card}` };
}

/** The patch's non-hero, non-item notes (map changes, mechanics, neutrals). */
export function renderGeneralPatchCard(notes: FeedPatchNotes): DotaCard | null {
  const lines = [`Общие изменения патча ${notes.patch_number}:`];
  for (const section of notes.general_notes ?? []) {
    const rendered = noteLines(section.generic);
    if (rendered.length === 0) continue;
    if (section.title) lines.push(`${section.title}:`);
    lines.push(...rendered);
  }
  if (lines.length === 1) return null;
  const card = lines.join('\n');
  return {
    card,
    summary: `Общие изменения патча ${notes.patch_number} (${(notes.general_notes ?? []).length} разделов)`,
    search: card,
  };
}
