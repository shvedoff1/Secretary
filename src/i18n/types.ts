/**
 * i18n primitives. A message catalog is a flat map of namespaced keys
 * (e.g. `auth.denied`, `preview.confirmed`) to a template string. Templates may
 * contain `{name}` placeholders filled from the `params` passed to `t`.
 *
 * The `ru` catalog is the source of truth for the KEY SET and reproduces the
 * bot's original wording verbatim, so a deployment on `BOT_LOCALE=ru` behaves
 * byte-for-byte as before i18n. Each catalog file types its `en` half as
 * `Record<keyof typeof <ns>Ru, string>`, so the compiler enforces that every
 * Russian key has an English translation (and a runtime test guards the reverse).
 */
export type Locale = 'en' | 'ru';

/** Substitute `{key}` placeholders in a template with the given params. */
export function interpolate(
  template: string,
  params?: Record<string, string | number>,
): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in params ? String(params[key]) : whole,
  );
}
