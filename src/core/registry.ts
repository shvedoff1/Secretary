import type { ExpenseProvider } from './provider.js';
import { SplidProvider } from '../providers/splid/index.js';

type ProviderFactory = () => ExpenseProvider;

const factories = new Map<string, ProviderFactory>();

export function registerProvider(name: string, factory: ProviderFactory): void {
  factories.set(name, factory);
}

export function getProvider(name: string): ExpenseProvider {
  const factory = factories.get(name);
  if (!factory) {
    throw new Error(`Unknown expense provider: "${name}"`);
  }
  return factory();
}

export function knownProviders(): string[] {
  return [...factories.keys()];
}

// --- Built-in registrations. Add new providers here. ---
registerProvider('splid', () => new SplidProvider());
