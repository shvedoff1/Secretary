import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Run the suite under the Russian locale. The bot's original wording IS the
    // `ru` catalog, so every behavior test that asserts an exact reply string
    // doubles as a guarantee that `BOT_LOCALE=ru` reproduces the pre-i18n output
    // verbatim — i.e. the main chat is unaffected. Locale-specific i18n tests set
    // their own BOT_LOCALE explicitly where they need `en`.
    env: { BOT_LOCALE: 'ru' },
  },
});
