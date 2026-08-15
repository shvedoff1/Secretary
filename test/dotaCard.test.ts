import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  renderAbility,
  renderGeneralPatchCard,
  renderHeroCard,
  renderItemCard,
  renderPatchCard,
} from '../src/dota/card.js';
import type { ConstantsData, FeedHero, FeedItem, FeedPatchNotes } from '../src/dota/feed.js';

function fixture<T>(name: string): T {
  const path = fileURLToPath(new URL(`./fixtures/dota/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

const hero = fixture<FeedHero>('hero_juggernaut_ru.json');
const blink = fixture<FeedItem>('item_blink_en.json');
const constants = fixture<ConstantsData>('dotaconstants_jugg.json');
const notes = fixture<FeedPatchNotes>('patchnotes_741e_ru.json');

describe('renderHeroCard', () => {
  const rendered = renderHeroCard(hero, constants, '7.41e');

  it('states the patch, the name and the internal key', () => {
    expect(rendered.card).toContain('Juggernaut');
    expect(rendered.card).toContain('npc_dota_hero_juggernaut');
    expect(rendered.card).toContain('патч 7.41e');
  });

  it('renders base stats and roles', () => {
    expect(rendered.card).toContain('ЛОВ 32+2.8');
    expect(rendered.card).toContain('главный атрибут: ловкость');
    expect(rendered.card).toContain('ближний бой');
    expect(rendered.card).toContain('Carry 2');
  });

  it('renders abilities with resolved cooldowns and numbers', () => {
    expect(rendered.card).toContain('перезарядка 30/26/22/18 с');
    expect(rendered.card).toContain('УРОН В СЕКУНДУ: 85/115/145/175');
  });

  it('groups talents by level using dotaconstants resolved names', () => {
    expect(rendered.card).toContain('10 ур.: -12s Healing Ward Cooldown');
    expect(rendered.card).toContain('25 ур.:');
    expect(rendered.card).toContain('+1s Omnislash Duration');
  });

  it('labels facets as third-party data (Valve ships none)', () => {
    expect(rendered.card).toContain('Bladestorm');
    expect(rendered.card).toContain('dotaconstants');
  });

  it('leaves no unresolved template anywhere in the card', () => {
    expect(rendered.card).not.toMatch(/\{[a-z]:/);
    expect(rendered.card).not.toMatch(/%[a-zA-Z_]{3,}%/);
  });

  it('keeps the summary short and the search text broad', () => {
    expect(rendered.summary.split('\n').length).toBeLessThanOrEqual(4);
    expect(rendered.summary.length).toBeLessThan(rendered.card.length);
    expect(rendered.search).toContain('Healing Ward');
  });

  it('never leaks a template from a facet description', () => {
    // dotaconstants ships facet text like "increased by {s:bonus_x} for every
    // level" with the values nowhere to be found.
    const withFacet = renderHeroCard(
      hero,
      {
        heroAbilities: {
          npc_dota_hero_juggernaut: {
            facets: [{ title: 'Tectonic Buildup', description: 'Radius +{s:bonus_range}.' }],
          },
        },
        abilities: {},
      },
      '7.41e',
    );
    expect(withFacet.card).toContain('Tectonic Buildup: Radius +?.');
    expect(withFacet.card).not.toContain('{s:');
  });

  it('never leaks a template from a dotaconstants talent name', () => {
    // Some dnames arrive with the placeholder still in them.
    const rendered2 = renderHeroCard(
      hero,
      {
        heroAbilities: {},
        abilities: { special_bonus_unique_juggernaut_5: { dname: '+{s:bonus_damage} Damage' } },
      },
      '7.41e',
    );
    expect(rendered2.card).toContain('+? Damage');
    expect(rendered2.card).not.toContain('{s:');
  });

  it('survives a hero with no constants (facets/talents degrade, nothing throws)', () => {
    const bare = renderHeroCard(hero, { heroAbilities: {}, abilities: {} }, '7.41e');
    expect(bare.card).toContain('Juggernaut');
    expect(bare.card).not.toContain('dotaconstants');
    // Talent templates have no values in the datafeed, so they degrade to '?'
    // rather than leaking `{s:bonus_x}` at the user.
    expect(bare.card).not.toMatch(/\{[a-z]:/);
  });
});

describe('renderItemCard', () => {
  const rendered = renderItemCard(blink, '7.41e');

  it('renders cost, cooldown and the resolved description', () => {
    expect(rendered.card).toContain('цена 2250 золота');
    expect(rendered.card).toContain('перезарядка 15 с');
    expect(rendered.card).toContain('1200 units away');
    expect(rendered.card).toContain('3 seconds after taking damage');
  });

  it('does not call a normal item a neutral one', () => {
    // The feed serialises "not neutral" (-1) as an unsigned 4294967295.
    expect(blink.item_neutral_tier).toBe(4294967295);
    expect(rendered.card).not.toContain('нейтральный');
  });
});

describe('stat headings', () => {
  it('strips the unlocalised $ sigil but keeps the label and the number', () => {
    const card = renderItemCard(
      {
        id: 9,
        name: 'item_broadsword',
        name_loc: 'Broadsword',
        item_cost: 1000,
        desc_loc: '',
        special_values: [{ name: 'damage', values_float: [15], heading_loc: '+$damage:' }],
      },
      '7.41e',
    );
    expect(card.card).toContain('Значения: +damage: 15');
    expect(card.card).not.toContain('$');
  });
});

describe('renderAbility', () => {
  it('compacts to a single line when asked', () => {
    const ability = (hero.abilities ?? [])[0]!;
    const line = renderAbility(ability, { compact: true });
    expect(line.split('\n')).toHaveLength(1);
    expect(line).toContain('Blade Fury');
  });
});

describe('patch cards', () => {
  it('renders a hero block with its per-ability notes', () => {
    const entry = (notes.heroes ?? [])[0]!;
    const card = renderPatchCard('Axe', '7.41e', entry.hero_notes, [
      { title: 'Battle Hunger', notes: entry.abilities?.[0]?.ability_notes },
    ]);
    expect(card?.card).toContain('Изменения в патче 7.41e — Axe');
    expect(card?.card).toContain('Базовая ловкость уменьшена с 20 до 18');
    expect(card?.card).toContain('Battle Hunger');
  });

  it('returns null when the patch says nothing about the entity', () => {
    expect(renderPatchCard('Axe', '7.41e', [], [])).toBeNull();
    expect(renderPatchCard('Axe', '7.41e', undefined)).toBeNull();
  });

  it('renders the general notes section', () => {
    const card = renderGeneralPatchCard(notes);
    expect(card?.card).toContain('Общие изменения патча 7.41e');
    expect(card?.card).toContain('Парные порталы');
  });
});
