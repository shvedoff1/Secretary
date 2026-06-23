// Points of interest: pure helpers (category model, Google Maps links, list
// rendering). Kept free of DB/Telegram deps so the formatting is unit-testable.

export type PoiCategory = 'cafe' | 'sight' | 'plan' | 'place';

/** Display metadata per category, in the order they should appear in a list. */
export const POI_CATEGORIES: { key: PoiCategory; emoji: string; label: string }[] = [
  { key: 'cafe', emoji: '☕️', label: 'Кафе и еда' },
  { key: 'sight', emoji: '🏛', label: 'Достопримечательности' },
  { key: 'plan', emoji: '📌', label: 'Планы' },
  { key: 'place', emoji: '📍', label: 'Места' },
];

const CATEGORY_KEYS = new Set<string>(POI_CATEGORIES.map((c) => c.key));

/** Coerce a free-form category hint from the model into a known category. */
export function normalizeCategory(raw: string | null | undefined): PoiCategory {
  const v = (raw ?? '').trim().toLowerCase();
  if (CATEGORY_KEYS.has(v)) return v as PoiCategory;
  // Tolerate common synonyms / Russian words the model might emit.
  if (/(cafe|caf[eé]|restaurant|food|еда|кафе|ресторан|бар|кофе)/.test(v)) return 'cafe';
  if (/(sight|landmark|attraction|museum|достоприм|музе|памятник)/.test(v)) return 'sight';
  if (/(plan|todo|wishlist|план|хочу|сходить)/.test(v)) return 'plan';
  return 'place';
}

export interface PoiView {
  id: number;
  name: string;
  category: PoiCategory;
  description?: string | null;
  address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

/**
 * Build a Google Maps link. With coordinates we point straight at the spot;
 * otherwise we hand Maps a text search over the name (+ address).
 */
export function mapsUrl(p: Pick<PoiView, 'name' | 'address' | 'latitude' | 'longitude'>): string {
  const base = 'https://www.google.com/maps/search/?api=1&query=';
  if (p.latitude != null && p.longitude != null) {
    return base + encodeURIComponent(`${p.latitude},${p.longitude}`);
  }
  const query = [p.name, p.address].filter((s) => s && s.trim()).join(' ');
  return base + encodeURIComponent(query);
}

/**
 * Render the list as Telegram-bound markdown, grouped by category with a Google
 * Maps link per point. Returns an empty string for an empty list.
 */
export function renderPoiList(pois: PoiView[]): string {
  if (pois.length === 0) return '';
  const lines: string[] = [`📍 Точки интереса (${pois.length})`];

  for (const cat of POI_CATEGORIES) {
    const group = pois.filter((p) => p.category === cat.key);
    if (group.length === 0) continue;
    lines.push('', `${cat.emoji} ${cat.label}`);
    for (const p of group) {
      const link = `[${p.name}](${mapsUrl(p)})`;
      const desc = p.description?.trim() ? ` — ${p.description.trim()}` : '';
      const addr = p.address?.trim() ? ` (${p.address.trim()})` : '';
      lines.push(`• ${link}${desc}${addr} · #${p.id}`);
    }
  }

  lines.push('', 'Удалить точку: /delpoi <id>');
  return lines.join('\n');
}
