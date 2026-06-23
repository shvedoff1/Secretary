import { describe, it, expect } from 'vitest';
import {
  normalizeCategory,
  mapsUrl,
  renderPoiList,
  type PoiView,
} from '../src/util/poi.js';

describe('normalizeCategory', () => {
  it('passes known categories through', () => {
    expect(normalizeCategory('cafe')).toBe('cafe');
    expect(normalizeCategory('sight')).toBe('sight');
    expect(normalizeCategory('plan')).toBe('plan');
    expect(normalizeCategory('place')).toBe('place');
  });

  it('maps synonyms (incl. Russian) to a known category', () => {
    expect(normalizeCategory('Restaurant')).toBe('cafe');
    expect(normalizeCategory('кафе')).toBe('cafe');
    expect(normalizeCategory('museum')).toBe('sight');
    expect(normalizeCategory('достопримечательность')).toBe('sight');
    expect(normalizeCategory('хочу сходить')).toBe('plan');
  });

  it('falls back to place for unknown/empty input', () => {
    expect(normalizeCategory('whatever')).toBe('place');
    expect(normalizeCategory('')).toBe('place');
    expect(normalizeCategory(null)).toBe('place');
    expect(normalizeCategory(undefined)).toBe('place');
  });
});

describe('mapsUrl', () => {
  it('uses coordinates when both are present', () => {
    const url = mapsUrl({ name: 'Spot', address: 'ignored', latitude: 38.7, longitude: -9.1 });
    expect(url).toBe('https://www.google.com/maps/search/?api=1&query=38.7%2C-9.1');
  });

  it('falls back to a text search over name + address when no coords', () => {
    const url = mapsUrl({ name: 'Tartine', address: 'Lisbon', latitude: null, longitude: null });
    expect(url).toBe('https://www.google.com/maps/search/?api=1&query=Tartine%20Lisbon');
  });

  it('searches by name alone when there is no address', () => {
    const url = mapsUrl({ name: 'Belém Tower', address: null, latitude: null, longitude: null });
    expect(url).toBe(
      'https://www.google.com/maps/search/?api=1&query=Bel%C3%A9m%20Tower',
    );
  });

  it('requires both coordinates, not just one', () => {
    const url = mapsUrl({ name: 'Half', address: null, latitude: 38.7, longitude: null });
    expect(url).toContain('query=Half');
  });
});

describe('renderPoiList', () => {
  const pois: PoiView[] = [
    { id: 1, name: 'Tartine', category: 'cafe', description: 'лучший флэт уайт', address: 'Lisbon' },
    { id: 2, name: 'Belém Tower', category: 'sight', latitude: 38.69, longitude: -9.21 },
    { id: 3, name: 'Sintra', category: 'plan', description: 'хотим съездить' },
  ];

  it('returns empty string for an empty list', () => {
    expect(renderPoiList([])).toBe('');
  });

  it('groups by category with headers in order', () => {
    const out = renderPoiList(pois);
    const cafeIdx = out.indexOf('Кафе и еда');
    const sightIdx = out.indexOf('Достопримечательности');
    const planIdx = out.indexOf('Планы');
    expect(cafeIdx).toBeGreaterThan(-1);
    expect(sightIdx).toBeGreaterThan(cafeIdx);
    expect(planIdx).toBeGreaterThan(sightIdx);
  });

  it('renders a maps link, description and id per point', () => {
    const out = renderPoiList(pois);
    expect(out).toContain('[Tartine](https://www.google.com/maps/search/?api=1&query=Tartine%20Lisbon)');
    expect(out).toContain('— лучший флэт уайт');
    expect(out).toContain('#1');
    // Coordinate-based link for the sight.
    expect(out).toContain('query=38.69%2C-9.21');
  });

  it('omits empty categories', () => {
    const out = renderPoiList([pois[0]!]);
    expect(out).toContain('Кафе и еда');
    expect(out).not.toContain('Достопримечательности');
    expect(out).not.toContain('Планы');
  });
});
