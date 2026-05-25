import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { BalanceResult, BalanceConfig, FetchContext } from "./types.js";
import {
  STATUS_KEY,
  REFRESH_INTERVAL_MS,
  DEFAULT_CONFIG,
} from "./types.js";
import {
  loadConfig,
  persistConfig,
  isProviderEnabled,
  setProviderEnabled,
} from "./config.js";
import { normalizeBaseUrl, hasHeader, formatBalance } from "./utils.js";
import { registry } from "./providers/registry.js";
import { openBalanceMenu, buildSupportReport } from "./menu.js";
import { resetSub2ApiProbeCache } from "./providers/sub2api.js";

// ══════════════════════════════════════════════════════════════
// Import provider modules to trigger auto-registration
// ══════════════════════════════════════════════════════════════
import "./providers/deepseek.js";
import "./providers/moonshot.js";
import "./providers/openrouter.js";
import "./providers/sub2api.js";
import "./providers/codex.js";

// ══════════════════════════════════════════════════════════════
// Re-exports for tests
// ══════════════════════════════════════════════════════════════
export { extractRemaining, getSub2ApiUsageUrls } from "./providers/sub2api.js";
export { extractMoonshotAvailableBalance } from "./providers/moonshot.js";
export { extractOpenRouterRemaining } from "./providers/openrouter.js";
export {
  normalizeBackendPayload,
  normalizeAppServerResponse,
  formatCodexUsageStatusline,
  selectCodexSnapshot,
} from "./providers/codex.js";

// ══════════════════════════════════════════════════════════════
// Main extension
// ══════════════════════════════════════════════════════════════

export default function (pi: ExtensionAPI) {
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let activeRequest: AbortController | undefined;
  let requestVersion = 0;
  let config: BalanceConfig = { ...DEFAULT_CONFIG };
  let currentCtx: ExtensionContext | undefined;

  const clearTimer = () => {
    if (!refreshTimer) return;
    clearTimeout(refreshTimer);
    refreshTimer = undefined;
  };

  const abortActiveRequest = () => {
    activeRequest?.abort();
    activeRequest = undefined;
  };

  const stopRefresh = () => {
    requestVersion++;
    clearTimer();
    abortActiveRequest();
  };

  const scheduleRefresh = () => {
    clearTimer();
    refreshTimer = setTimeout(() => void refreshBalance(), REFRESH_INTERVAL_MS);
  };

  const refreshBalance = async () => {
    const ctx = currentCtx;
    if (!ctx) return;

    const version = ++requestVersion;
    const model = ctx.model;

    clearTimer();
    abortActiveRequest();
    ctx.ui.setStatus(STATUS_KEY, undefined);

    if (!model) return;

    const controller = new AbortController();
    activeRequest = controller;

    try {
      const result = await fetchProviderBalance(ctx, model, config, controller.signal);
      if (version !== requestVersion || controller.signal.aborted) return;

      if (result) {
        if ("text" in result) {
          ctx.ui.setStatus(STATUS_KEY, result.text);
        } else {
          const providerName =
            ctx.modelRegistry.getProviderDisplayName(model.provider) || model.provider;
          ctx.ui.setStatus(STATUS_KEY, `${providerName}: ${formatBalance(result)}`);
        }
      } else {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
    } catch {
      if (version === requestVersion) ctx.ui.setStatus(STATUS_KEY, undefined);
    } finally {
      if (version === requestVersion) {
        activeRequest = undefined;
        scheduleRefresh();
      }
    }
  };

  // ── Command registration ─────────────────────────────────

  pi.registerCommand("balance", {
    description: "pi-balance: status / enable|disable|toggle <provider> / sub2api / refresh",
    getArgumentCompletions: (prefix: string) => {
      const trimmed = prefix.trim();
      // Provider names for enable/disable/toggle
      const providerNames = registry.getAll().map((p) => p.definition.label);
      const providerKeys = registry.getAll().map((p) => p.key);

      if (trimmed.startsWith("enable ")) {
        const partial = trimmed.slice("enable ".length);
        return providerNames
          .filter((n) => n.toLowerCase().startsWith(partial.toLowerCase()))
          .map((n) => ({ value: `enable ${n}`, label: `enable ${n}` }));
      }
      if (trimmed.startsWith("disable ")) {
        const partial = trimmed.slice("disable ".length);
        return providerNames
          .filter((n) => n.toLowerCase().startsWith(partial.toLowerCase()))
          .map((n) => ({ value: `disable ${n}`, label: `disable ${n}` }));
      }
      if (trimmed.startsWith("toggle ")) {
        const partial = trimmed.slice("toggle ".length);
        return providerNames
          .filter((n) => n.toLowerCase().startsWith(partial.toLowerCase()))
          .map((n) => ({ value: `toggle ${n}`, label: `toggle ${n}` }));
      }

      const commands = ["status", "refresh", "enable ", "disable ", "toggle ", "sub2api", "sub2api rescan"];
      return commands
        .filter((c) => c.startsWith(trimmed))
        .map((c) => ({ value: c, label: c }));
    },
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();

      config = loadConfig(ctx);

      // refresh
      if (action === "refresh") {
        await refreshBalance();
        ctx.ui.notify("余额状态已刷新", "info");
        return;
      }

      // status — show support report
      // menu — open interactive menu (hasUI check)
      if (action === "" && ctx.hasUI) {
        await openBalanceMenu(pi, ctx, config, async (nextConfig) => {
          config = nextConfig;
          persistConfig(pi, config);
          await refreshBalance();
        });
        return;
      }

      // status — show support report
      if (action === "status") {
        ctx.ui.notify(await buildSupportReport(ctx, config), "info");
        return;
      }

      // sub2api sub-menu
      if (action === "sub2api") {
        const sub2apiProvider = registry.get("sub2api");
        if (sub2apiProvider?.openCustomSubMenu) {
          await sub2apiProvider.openCustomSubMenu(pi, ctx, config, async (nextConfig) => {
            config = nextConfig;
            persistConfig(pi, config);
            await refreshBalance();
          });
        }
        return;
      }

      // sub2api rescan
      if (action === "sub2api rescan" || action === "rescan sub2api") {
        resetSub2ApiProbeCache();
        ctx.ui.notify("Sub2Api provider 探测缓存已清空，将重新扫描", "info");
        // Open Sub2Api sub-menu after rescan
        const sub2apiProvider = registry.get("sub2api");
        if (sub2apiProvider?.openCustomSubMenu) {
          await sub2apiProvider.openCustomSubMenu(pi, ctx, config, async (nextConfig) => {
            config = nextConfig;
            persistConfig(pi, config);
            await refreshBalance();
          });
        }
        return;
      }

      // enable <provider>
      if (action.startsWith("enable ")) {
        const providerArg = action.slice("enable ".length);
        const provider = registry.findByFuzzyName(providerArg);
        if (!provider) {
          ctx.ui.notify(`未知 provider：${providerArg}`, "error");
          return;
        }
        config = setProviderEnabled(config, provider.key, true);
        persistConfig(pi, config);
        await refreshBalance();
        ctx.ui.notify(`${provider.definition.label} 显示已开启`, "info");
        return;
      }

      // disable <provider>
      if (action.startsWith("disable ")) {
        const providerArg = action.slice("disable ".length);
        const provider = registry.findByFuzzyName(providerArg);
        if (!provider) {
          ctx.ui.notify(`未知 provider：${providerArg}`, "error");
          return;
        }
        config = setProviderEnabled(config, provider.key, false);
        persistConfig(pi, config);
        await refreshBalance();
        ctx.ui.notify(`${provider.definition.label} 显示已关闭`, "info");
        return;
      }

      // toggle <provider>
      if (action.startsWith("toggle ")) {
        const providerArg = action.slice("toggle ".length);
        const provider = registry.findByFuzzyName(providerArg);
        if (!provider) {
          ctx.ui.notify(`未知 provider：${providerArg}`, "error");
          return;
        }
        config = setProviderEnabled(
          config,
          provider.key,
          !isProviderEnabled(config, provider.key),
        );
        persistConfig(pi, config);
        await refreshBalance();
        ctx.ui.notify(
          `${provider.definition.label} 显示已${
            isProviderEnabled(config, provider.key) ? "开启" : "关闭"
          }`,
          "info",
        );
        return;
      }

      // unknown → show status
      ctx.ui.notify(await buildSupportReport(ctx, config), "info");
    },
  });

  // ── Lifecycle events ────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    config = loadConfig(ctx);
    void refreshBalance();
  });

  pi.on("model_select", async (_event, ctx) => {
    currentCtx = ctx;
    config = loadConfig(ctx);
    void refreshBalance();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopRefresh();
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}

// ══════════════════════════════════════════════════════════════
// Balance fetch orchestration
// ══════════════════════════════════════════════════════════════

async function fetchProviderBalance(
  ctx: ExtensionContext,
  model: Model<Api>,
  config: BalanceConfig,
  signal?: AbortSignal,
): Promise<BalanceResult | undefined> {
  const baseUrl = normalizeBaseUrl(model.baseUrl);
  if (!baseUrl) return undefined;

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) return undefined;

  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(model.headers ?? {}),
    ...(auth.headers ?? {}),
  };
  if (auth.apiKey && !hasHeader(headers, "authorization")) {
    headers.Authorization = `Bearer ${auth.apiKey}`;
  }

  const context: FetchContext = { model, baseUrl, headers, config };

  for (const provider of registry.getAll()) {
    if (signal?.aborted) return undefined;
    if (!isProviderEnabled(config, provider.key)) continue;
    if (!provider.shouldTry(model, baseUrl)) continue;
    const result = await provider.fetchBalance(context, signal);
    if (result) return result;
  }

  return undefined;
}
