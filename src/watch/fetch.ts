import { loadConfig } from '../config.js';

// Plain fetch of a watched page — the only place watch HTTP happens (mirroring
// the "one module touches the API" rule of splid/surf). A browser-ish UA and an
// Accept-Language help against sites that reject bare bot requests.

const MAX_BYTES = 2_000_000;

export async function fetchPageHtml(url: string, timeoutMs?: number): Promise<string> {
  const cfg = loadConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? cfg.WATCH_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
      },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} for ${url}`);
    }
    const text = await res.text();
    return text.length > MAX_BYTES ? text.slice(0, MAX_BYTES) : text;
  } finally {
    clearTimeout(timer);
  }
}
