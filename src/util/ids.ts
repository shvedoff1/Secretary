import { randomBytes } from 'node:crypto';

// Short URL-safe id used in callback_data (Telegram limits callback_data to 64
// bytes, so keep these compact).
export function shortId(bytes = 8): string {
  return randomBytes(bytes).toString('base64url');
}

export function normalizeName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}
