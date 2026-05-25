import type { BalanceProvider } from "./types.js";
import type { ProviderKey, ProviderDefinition } from "../types.js";

/**
 * Central registry for balance providers.
 *
 * Providers register themselves and the main controller queries the registry
 * for menus, balance fetching, and support reports.  Adding a new provider
 * is a single register() call.
 */
class ProviderRegistry {
  private providers: BalanceProvider[] = [];
  private byKey = new Map<ProviderKey, BalanceProvider>();

  register(provider: BalanceProvider): void {
    this.providers.push(provider);
    this.byKey.set(provider.key, provider);
  }

  /** All registered providers in registration order */
  getAll(): readonly BalanceProvider[] {
    return this.providers;
  }

  /** Lookup by key */
  get(key: ProviderKey): BalanceProvider | undefined {
    return this.byKey.get(key);
  }

  /** All registered ProviderDefinition records */
  getDefinitions(): readonly ProviderDefinition[] {
    return this.providers.map((p) => p.definition);
  }

  /** Find provider by fuzzy name (key, label, prefix) */
  findByFuzzyName(value: string): BalanceProvider | undefined {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return undefined;
    return this.providers.find(
      (p) =>
        p.key === normalized ||
        p.definition.label.toLowerCase() === normalized ||
        p.definition.label.toLowerCase().startsWith(normalized),
    );
  }
}

/** Singleton registry */
export const registry = new ProviderRegistry();
