import type Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from '../config.js';

/**
 * Web search on LLM_PROVIDER=deepseek. Claude's `web_search` is a SERVER tool —
 * Anthropic runs it — and DeepSeek's endpoint has no such thing, but DeepSeek
 * sells the same job as two plain HTTP APIs (Search + Fetch, billed per
 * successful request, failures/empty results free). The deepseek translator
 * (`deepseek.ts`) offers them to the model as ordinary function tools under the
 * same `web_search` name and runs them itself, so the dialogue loop never learns
 * the difference. This file is the only place that HTTP happens.
 */

export const DS_SEARCH_TOOL = 'web_search';
export const DS_FETCH_TOOL = 'web_fetch';

export const DS_SEARCH_TOOLS: Anthropic.Tool[] = [
  {
    name: DS_SEARCH_TOOL,
    description:
      'Search the web for current information (news, prices, schedules, opening hours, facts you are not sure of). Returns titles, URLs, dates and snippets. Query ≤128 chars; `site:` works. Read a promising result in full with web_fetch before quoting exact details from it.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'The search query' } },
      required: ['query'],
    },
  },
  {
    name: DS_FETCH_TOOL,
    description:
      'Read ONE web page (a URL from web_search results or from the conversation) as text. Use it when a snippet is not enough.',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'http(s) URL of the page' } },
      required: ['url'],
    },
  },
];

export function isDsSearchTool(name: string): boolean {
  return name === DS_SEARCH_TOOL || name === DS_FETCH_TOOL;
}

/** What one emulated tool call hands back to the model. */
export interface DsToolOutput {
  text: string;
  isError: boolean;
}

const SEARCH_COUNT = 8;
const SNIPPET_MAX = 700;
/** A fetched page lands in the context as tokens — cap it. */
export const FETCH_MAX_CHARS = 15_000;
const TIMEOUT_MS = 30_000;

interface SearchResult {
  title?: string;
  url?: string;
  date?: string;
  snippet?: string;
  summary?: string;
}

/** Search API answer → numbered list for the model. Pure, for tests. */
export function renderSearchResults(query: string, results: SearchResult[]): string {
  if (results.length === 0) return `Ничего не найдено по запросу «${query}».`;
  return results
    .map((r, i) => {
      const body = (r.summary || r.snippet || '').replace(/\s+/g, ' ').trim().slice(0, SNIPPET_MAX);
      const head = `${i + 1}. ${r.title ?? '(без заголовка)'}${r.date ? ` (${r.date})` : ''}`;
      return [head, r.url ?? '', body].filter(Boolean).join('\n');
    })
    .join('\n\n');
}

/** Fetch API answer → page text, with the cut stated. Pure, for tests. */
export function renderFetchedPage(url: string, title: string | undefined, content: string): string {
  const cut = content.length > FETCH_MAX_CHARS;
  const body = cut ? content.slice(0, FETCH_MAX_CHARS) : content;
  return [
    title ? `${title}\n${url}` : url,
    '',
    body,
    ...(cut ? ['', `[страница обрезана: показано ${FETCH_MAX_CHARS} из ${content.length} символов]`] : []),
  ].join('\n');
}

async function post(path: string, body: unknown): Promise<Response> {
  const cfg = loadConfig();
  return fetch(`${cfg.DEEPSEEK_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.DEEPSEEK_API_KEY ?? ''}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/** Run one emulated web_search / web_fetch call. Never throws: a failure is an
 *  is_error result the model can talk around, like a failed server search. */
export async function runDsSearchTool(name: string, input: unknown): Promise<DsToolOutput> {
  const args = (input ?? {}) as { query?: unknown; url?: unknown };
  try {
    if (name === DS_SEARCH_TOOL) {
      const query = String(args.query ?? '').trim().slice(0, 128);
      if (!query) return { text: 'Пустой запрос.', isError: true };
      const res = await post('/v1/tools/search', { query, count: SEARCH_COUNT });
      if (!res.ok) {
        return { text: `Поиск не ответил: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`.trim(), isError: true };
      }
      const data = (await res.json()) as { results?: SearchResult[] };
      return { text: renderSearchResults(query, data.results ?? []), isError: false };
    }
    const url = String(args.url ?? '').trim();
    if (!/^https?:\/\//i.test(url)) return { text: 'Нужен http(s) URL.', isError: true };
    const res = await post('/v1/tools/fetch', { url: url.slice(0, 8192) });
    if (res.status === 404) return { text: `Страница не читается: ${url}`, isError: true };
    if (!res.ok) return { text: `Не удалось открыть страницу: HTTP ${res.status}`, isError: true };
    const data = (await res.json()) as { title?: string; content?: string };
    return { text: renderFetchedPage(url, data.title, data.content ?? ''), isError: false };
  } catch (err) {
    const msg = err instanceof Error && err.name === 'TimeoutError' ? 'таймаут' : String(err);
    return { text: `Поиск недоступен: ${msg}`.slice(0, 300), isError: true };
  }
}
