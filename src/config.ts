import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  BalanceConfig,
  ProviderKey,
  ProviderDefinition,
} from "./types.js";
import {
  CONFIG_ENTRY_TYPE,
  DEFAULT_CONFIG,
  PROVIDER_KEYS,
} from "./types.js";
import { getRecord } from "./utils.js";

const PROVIDER_KEY_SET = new Set<string>(PROVIDER_KEYS);

// ══════════════════════════════════════════════════════════════
// Config load / persist
// ══════════════════════════════════════════════════════════════

export function loadConfig(ctx: ExtensionContext): BalanceConfig {
  const entries = ctx.sessionManager.getEntries();

  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== CONFIG_ENTRY_TYPE) continue;
    return normalizeConfig(entry.data);
  }

  return DEFAULT_CONFIG;
}

function normalizeConfig(value: unknown): BalanceConfig {
  const record = getRecord(value);
  const disabledProviders = Array.isArray(record?.disabledProviders)
    ? record.disabledProviders.filter(isProviderKey)
    : [];
  const disabledSub2ApiProviders = Array.isArray(record?.disabledSub2ApiProviders)
    ? record.disabledSub2ApiProviders.filter((provider): provider is string => typeof provider === "string")
    : [];

  return {
    disabledProviders: [...new Set(disabledProviders)],
    disabledSub2ApiProviders: [...new Set(disabledSub2ApiProviders)],
    codexAppServerFallback: record?.codexAppServerFallback !== false,
  };
}

export function persistConfig(pi: ExtensionAPI, config: BalanceConfig): void {
  pi.appendEntry(CONFIG_ENTRY_TYPE, config);
}

// ══════════════════════════════════════════════════════════════
// Provider enable / disable
// ══════════════════════════════════════════════════════════════

export function findProvider(
  value: string | undefined,
  providers: readonly ProviderDefinition[],
): ProviderDefinition | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;

  return providers.find(
    (provider) =>
      provider.key === normalized ||
      provider.label.toLowerCase() === normalized ||
      provider.label.toLowerCase().startsWith(normalized),
  );
}

export function isProviderEnabled(config: BalanceConfig, provider: ProviderKey): boolean {
  return !config.disabledProviders.includes(provider);
}

export function setProviderEnabled(
  config: BalanceConfig,
  provider: ProviderKey,
  enabled: boolean,
): BalanceConfig {
  const disabledProviders = new Set(config.disabledProviders);
  if (enabled) {
    disabledProviders.delete(provider);
  } else {
    disabledProviders.add(provider);
  }
  return { ...config, disabledProviders: [...disabledProviders] };
}

export function isSub2ApiProviderEnabled(config: BalanceConfig, provider: string): boolean {
  return !config.disabledSub2ApiProviders.includes(provider);
}

export function setSub2ApiProviderEnabled(
  config: BalanceConfig,
  provider: string,
  enabled: boolean,
): BalanceConfig {
  const disabledSub2ApiProviders = new Set(config.disabledSub2ApiProviders);
  if (enabled) {
    disabledSub2ApiProviders.delete(provider);
  } else {
    disabledSub2ApiProviders.add(provider);
  }
  return { ...config, disabledSub2ApiProviders: [...disabledSub2ApiProviders] };
}

function isProviderKey(value: unknown): value is ProviderKey {
  return typeof value === "string" && PROVIDER_KEY_SET.has(value);
}
