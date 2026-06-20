import Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from '../config.js';

let client: Anthropic | undefined;

export function getAnthropic(): Anthropic {
  if (client) return client;
  const { ANTHROPIC_API_KEY } = loadConfig();
  client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  return client;
}
