import { loadConfig } from '../config.js';

// Plain fetch of a calendar's ICS feed — the ONLY place calendar HTTP happens
// (mirroring the one-module-touches-the-API rule of splid/surf/watch/dota).
// The URL is a SECRET (it grants read access to the whole calendar), so it must
// never appear in thrown errors or logs — errors carry a generic message.

const MAX_BYTES = 5_000_000;

export async function fetchIcs(url: string, timeoutMs?: number): Promise<string> {
  const cfg = loadConfig();
  // Google's UI offers the address as webcal:// in some clients; same feed over https.
  const target = url.replace(/^webcal:/i, 'https:');
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    timeoutMs ?? cfg.CALENDAR_FETCH_TIMEOUT_MS,
  );
  try {
    const res = await fetch(target, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'secretary-bot/1.0 (calendar sync)',
        Accept: 'text/calendar, text/plain;q=0.9, */*;q=0.5',
      },
    });
    if (!res.ok) {
      // No URL in the message — it is a secret and errors get logged.
      throw new Error(`calendar feed returned HTTP ${res.status}`);
    }
    const text = await res.text();
    return text.length > MAX_BYTES ? text.slice(0, MAX_BYTES) : text;
  } finally {
    clearTimeout(timer);
  }
}
