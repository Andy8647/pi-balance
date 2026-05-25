import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BalanceConfig, ProviderSupport, MenuOption } from "./types.js";
import {
  MENU_UNAVAILABLE_COLOR,
  MENU_MUTED_COLOR,
  MENU_COLOR_RESET,
} from "./types.js";
import {
  isProviderEnabled,
  setProviderEnabled,
  isSub2ApiProviderEnabled,
  setSub2ApiProviderEnabled,
} from "./config.js";
import type { BalanceProvider, ExtraMenuAction } from "./providers/types.js";
import { registry } from "./providers/registry.js";
import { getSub2ApiProviderCandidates } from "./providers/sub2api.js";

// ══════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════

function formatEnabled(enabled: boolean): string {
  return enabled ? "◉" : "○";
}

function formatUnavailableMenuLabel(label: string): string {
  return `${MENU_UNAVAILABLE_COLOR}${label}${MENU_COLOR_RESET}`;
}

function formatMutedMenuText(text: string): string {
  return `${MENU_MUTED_COLOR}${text}${MENU_COLOR_RESET}`;
}

function getProviderUnavailableReason(support: ProviderSupport | undefined): string {
  if (!support) return "未就绪";
  const unavailableDetail = support.details.find(
    (detail) => detail.includes("不可用") || detail.includes("未发现"),
  );
  return unavailableDetail ?? "未就绪";
}

function providerMenuText(
  prefix: string,
  provider: BalanceProvider,
  support: ProviderSupport | undefined,
): string {
  const configured = support?.configured ?? false;
  const suffix = configured ? "" : ` (${getProviderUnavailableReason(support)})`;
  return `${prefix} ${provider.definition.label}${suffix}`;
}

function providerMenuOption(
  prefix: string,
  provider: BalanceProvider,
  support: ProviderSupport | undefined,
): MenuOption {
  const text = providerMenuText(prefix, provider, support);
  const labelText = support?.configured ?? false ? text : formatUnavailableMenuLabel(text);
  return { choice: text, label: labelText, value: labelText };
}

function simpleOption(choice: string, label: string): MenuOption {
  return { choice, label, value: label };
}

function displayActionLabel(icon: string, action: string, providerLabel: string): string {
  return `  ${icon} ${action}${formatMutedMenuText(` - ${providerLabel}`)}`;
}

// ══════════════════════════════════════════════════════════════
// Choice handler types
// ══════════════════════════════════════════════════════════════

type ChoiceHandler =
  | { kind: "expand"; provider: BalanceProvider }
  | { kind: "display-toggle"; provider: BalanceProvider }
  | { kind: "extra-action"; provider: BalanceProvider; action: ExtraMenuAction }
  | { kind: "sub2api-toggle"; provider: BalanceProvider; subProvider: string }
  | { kind: "refresh" }
  | { kind: "back" };

// ══════════════════════════════════════════════════════════════
// Menu building — with support caching
// ══════════════════════════════════════════════════════════════

/**
 * Open the main balance configuration menu.
 *
 * Supports are cached: expand/collapse doesn't cause recomputation.
 * Sub2Api sub-providers appear inline when expanded.
 */
export async function openBalanceMenu(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: BalanceConfig,
  onConfigChange: (cfg: BalanceConfig) => Promise<void>,
): Promise<void> {
  const providers = registry.getAll();
  const expanded = new Map<string, boolean>();

  // Caches – only invalidated when config changes
  let cachedSupports: ProviderSupport[] | null = null;
  let cachedConfigSig = "";
  let cachedSub2ApiProviders: string[] | null = null;

  const configSig = (cfg: BalanceConfig): string =>
    cfg.disabledProviders.join(",") +
    "|" +
    cfg.disabledSub2ApiProviders.join(",") +
    "|" +
    cfg.codexAppServerFallback;

  while (true) {
    // Only recompute supports when config actually changed
    const sig = configSig(config);
    let allSupports: ProviderSupport[];
    if (cachedSupports && sig === cachedConfigSig) {
      allSupports = cachedSupports;
    } else {
      allSupports = await getAllSupports(ctx, config);
      cachedSupports = allSupports;
      cachedConfigSig = sig;
      cachedSub2ApiProviders = null;
    }

    const choices = new Map<string, ChoiceHandler>();
    const options: MenuOption[] = [];

    // Refresh
    choices.set("Refresh", { kind: "refresh" });
    options.push({ label: "Refresh", value: "Refresh", choice: "Refresh" });

    for (const provider of providers) {
      const support = allSupports.find((s) => s.provider.key === provider.key);
      const enabled = isProviderEnabled(config, provider.key);
      const isExpanded = expanded.get(provider.key) ?? false;
      const prefix = isExpanded ? "▼" : "▶";

      // Main provider entry
      const mainOption = providerMenuOption(prefix, provider, support);
      choices.set(mainOption.value, { kind: "expand", provider });
      options.push(mainOption);

      if (!isExpanded) continue;

      // Display toggle
      const displayLabel = displayActionLabel(
        formatEnabled(enabled),
        "Display",
        provider.definition.label,
      );
      const displayOpt = simpleOption(`display-${provider.key}`, displayLabel);
      choices.set(displayOpt.value, { kind: "display-toggle", provider });
      options.push(displayOpt);

      // Extra actions (Codex CLI fallback)
      const extraActions =
        provider.getExtraMenuActions?.(config, support ?? {
          provider: provider.definition,
          configured: false,
          enabled: false,
          details: [],
        }) ?? [];
      for (const action of extraActions) {
        const label = action.getLabel(config);
        const opt = simpleOption(action.id, label);
        choices.set(opt.value, { kind: "extra-action", provider, action });
        options.push(opt);
      }

      // Sub2Api inline sub-providers (cached)
      if (provider.key === "sub2api" && support?.configured) {
        if (!cachedSub2ApiProviders) {
          cachedSub2ApiProviders = await getSub2ApiProviderCandidates(ctx);
        }
        for (const subProvider of cachedSub2ApiProviders) {
          const icon = formatEnabled(isSub2ApiProviderEnabled(config, subProvider));
          const label = `  ${icon} ${subProvider}`;
          const opt = simpleOption(`s2a-${subProvider}`, label);
          choices.set(opt.value, { kind: "sub2api-toggle", provider, subProvider });
          options.push(opt);
        }
      }
    }

    // Back
    choices.set("Back", { kind: "back" });
    options.push({ label: "Back", value: "Back", choice: "Back" });

    const choiceValue = await ctx.ui.select("pi-balance", options.map((o) => o.value));
    if (!choiceValue || choiceValue === "Back") return;

    const handler = choices.get(choiceValue);
    if (!handler) continue;

    switch (handler.kind) {
      case "refresh": {
        await onConfigChange(config);
        break;
      }
      case "expand": {
        // Only expand state changes — no config change, caches stay valid
        toggleExpanded(expanded, handler.provider.key);
        break;
      }
      case "display-toggle": {
        const nextConfig = setProviderEnabled(
          config,
          handler.provider.key,
          !isProviderEnabled(config, handler.provider.key),
        );
        config = nextConfig;
        await onConfigChange(nextConfig);
        break;
      }
      case "extra-action": {
        const nextConfig = handler.action.onToggle(config);
        config = nextConfig;
        await onConfigChange(nextConfig);
        break;
      }
      case "sub2api-toggle": {
        const nextConfig = setSub2ApiProviderEnabled(
          config,
          handler.subProvider,
          !isSub2ApiProviderEnabled(config, handler.subProvider),
        );
        config = nextConfig;
        await onConfigChange(nextConfig);
        break;
      }
      case "back":
        return;
    }
  }
}

function toggleExpanded(expanded: Map<string, boolean>, key: string): void {
  expanded.set(key, !(expanded.get(key) ?? false));
}

// ══════════════════════════════════════════════════════════════
// Support queries
// ══════════════════════════════════════════════════════════════

export async function getAllSupports(
  ctx: ExtensionContext,
  config: BalanceConfig,
): Promise<ProviderSupport[]> {
  const providers = registry.getAll();
  const results: ProviderSupport[] = [];

  for (const provider of providers) {
    const support = await provider.getSupport(ctx, config);
    results.push({
      ...support,
      enabled: isProviderEnabled(config, provider.key),
    });
  }

  return results;
}

export async function buildSupportReport(
  ctx: ExtensionContext,
  config: BalanceConfig,
): Promise<string> {
  return formatSupportReport(await getAllSupports(ctx, config));
}

function formatSupportReport(supports: ProviderSupport[]): string {
  return supports
    .map((support) => {
      const enabled = support.enabled ? "开启" : "关闭";
      const configured = support.configured ? "可用" : "未就绪";
      return `${support.provider.label}: ${enabled} / ${configured}\n  ${support.details.join("；")}`;
    })
    .join("\n\n");
}
