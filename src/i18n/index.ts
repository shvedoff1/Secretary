import { interpolate, type Locale } from './types.js';
import { coreRu, coreEn } from './catalogs/core.js';
import { commandsBasicRu, commandsBasicEn } from './catalogs/commandsBasic.js';
import { commandsDataRu, commandsDataEn } from './catalogs/commandsData.js';
import { adminRu, adminEn } from './catalogs/admin.js';
import { assistRu, assistEn } from './catalogs/assist.js';
import { miscRu, miscEn } from './catalogs/misc.js';

/**
 * Merged message catalogs. Keys are namespaced per catalog file so the spreads
 * never collide. `ru` is the source of truth for the key set (and reproduces the
 * original wording verbatim); `en` mirrors it. `test/i18n.test.ts` asserts the two
 * halves stay in sync so a missing translation can't slip through.
 */
export const ru = {
  ...coreRu,
  ...commandsBasicRu,
  ...commandsDataRu,
  ...adminRu,
  ...assistRu,
  ...miscRu,
};

export const en = {
  ...coreEn,
  ...commandsBasicEn,
  ...commandsDataEn,
  ...adminEn,
  ...assistEn,
  ...miscEn,
};

export type MessageKey = keyof typeof ru;

const catalogs: Record<Locale, Record<string, string>> = { ru, en };

/**
 * The active locale. Read straight from `process.env.BOT_LOCALE` (default `en`)
 * rather than through `loadConfig()`, so translating a string never requires the
 * full runtime config to be present/valid — pure formatters (previews, reports)
 * call `t()` and must stay usable without BOT_TOKEN etc. `config.ts` still declares
 * and validates BOT_LOCALE for startup; this is the same value, read cheaply.
 */
export function currentLocale(): Locale {
  return process.env.BOT_LOCALE?.trim().toLowerCase() === 'ru' ? 'ru' : 'en';
}

/** BCP-47 tag for the active locale, for `Intl.*` date/number formatting. */
export function intlLocaleTag(): string {
  return currentLocale() === 'ru' ? 'ru-RU' : 'en-US';
}

/**
 * Translate a namespaced key into the active `BOT_LOCALE`, filling any
 * `{placeholder}` from `params`. Falls back to the Russian (source) string, then
 * to the raw key, so a lookup miss degrades gracefully instead of throwing.
 */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const template = catalogs[currentLocale()]?.[key] ?? ru[key] ?? key;
  return interpolate(template, params);
}

export type { Locale } from './types.js';
