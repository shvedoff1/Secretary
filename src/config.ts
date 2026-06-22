import 'dotenv/config';
import { z } from 'zod';

const boolish = z
  .string()
  .transform((v) => v.trim().toLowerCase())
  .pipe(z.enum(['true', 'false', '1', '0', 'yes', 'no']))
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const ConfigSchema = z.object({
  BOT_TOKEN: z.string().min(1, 'BOT_TOKEN is required'),
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
  ADMIN_TELEGRAM_ID: z.coerce.number().int().positive(),

  ANTHROPIC_MODEL: z.string().default('claude-opus-4-8'),
  DEFAULT_CURRENCY: z
    .string()
    .length(3)
    .transform((v) => v.toUpperCase())
    .default('EUR'),
  DATABASE_PATH: z.string().default('./data/bot.sqlite'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
  PENDING_TTL_MINUTES: z.coerce.number().int().positive().default(30),
  CONVERSATION_HISTORY_LIMIT: z.coerce.number().int().positive().default(20),
  ENABLE_WEB_SEARCH: boolish.default(true),
  // Fallback IANA timezone for reminders when a chat hasn't set one yet.
  DEFAULT_TIMEZONE: z.string().min(1).default('UTC'),
});

export type Config = z.infer<typeof ConfigSchema>;

let cached: Config | undefined;

export function loadConfig(): Config {
  if (cached) return cached;
  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}
