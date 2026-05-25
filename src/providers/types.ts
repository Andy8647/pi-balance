import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  BalanceResult,
  BalanceConfig,
  ProviderKey,
  ProviderDefinition,
  ProviderSupport,
  FetchContext,
} from "../types.js";

/**
 * Interface that every balance provider module must implement.
 *
 * Register in providers/registry.ts and the main controller automatically:
 * - includes it in menus
 * - routes balance fetches
 * - computes support status
 */
export interface BalanceProvider {
  /** Unique key matching ProviderKey */
  readonly key: ProviderKey;
  /** Metadata for menus / status reports */
  readonly definition: ProviderDefinition;

  /** Whether this provider should attempt to fetch for the given model + baseUrl */
  shouldTry(model: Model<Api>, baseUrl: string): boolean;

  /** Attempt to fetch balance.  Return undefined when unavailable. */
  fetchBalance(context: FetchContext, signal?: AbortSignal): Promise<BalanceResult | undefined>;

  /** Compute availability + detail strings for the current session / model. */
  getSupport(
    ctx: ExtensionContext,
    config: BalanceConfig,
  ): ProviderSupport | Promise<ProviderSupport>;

  /**
   * Optional: extra menu toggle actions beyond the standard enable/disable toggle.
   * Each action is rendered as a sub-item.  When selected, the returned config is persisted.
   */
  getExtraMenuActions?(
    config: BalanceConfig,
    support: ProviderSupport,
  ): ExtraMenuAction[];
  /**
   * Optional: open a custom sub-menu (used by Sub2Api for /balance sub2api).
   */
  openCustomSubMenu?(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    config: BalanceConfig,
    onConfigChange: (cfg: BalanceConfig) => Promise<void>,
  ): Promise<void>;
}

export interface ExtraMenuAction {
  /** Stable identifier for the action */
  readonly id: string;
  /** Returns the label shown in the menu (receives current config for live state). */
  getLabel(config: BalanceConfig): string;
  /** Called on toggle — returns the new config. */
  onToggle(config: BalanceConfig): BalanceConfig;
}
