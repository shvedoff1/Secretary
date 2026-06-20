import Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from '../config.js';

let client: Anthropic | undefined;

export function getAnthropic(): Anthropic {
  if (client) return client;
  const { ANTHROPIC_API_KEY } = loadConfig();
  // The SDK retries transient failures (429, 5xx incl. 529 "Overloaded") with
  // exponential backoff + jitter and respects retry-after. Bump from the
  // default 2 so brief overloads don't surface as a user-facing error.
  client = new Anthropic({
    apiKey: ANTHROPIC_API_KEY,
    maxRetries: 5,
    timeout: 120_000,
  });
  return client;
}
