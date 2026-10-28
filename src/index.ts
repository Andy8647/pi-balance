import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { BalanceResult, BalanceConfig, FetchContext } from "./types.js";
import {
  STATUS_KEY,
  DEFAULT_CONFIG,
  REFRESH_INTERVAL_MS,
} from "./types.js";
import {
  loadConfig,
  persistConfig,
  isProviderEnabled,
  setProviderEnabled,
} from "./config.js";
import { normalizeBaseUrl, hasHeader, formatBalance, formatNumber } from "./utils.js";
import { registry } from "./providers/registry.js";
import { openBalanceMenu, buildSupportReport } from "./menu.js";
import { resetSub2ApiProbeCache } from "./providers/sub2api.js";
import { t, setLanguage } from "./i18n/index.js";

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
  let activeRequest: AbortController | undefined;
  let requestVersion = 0;
  let config: BalanceConfig = { ...DEFAULT_CONFIG };
  let currentCtx: ExtensionContext | undefined;
  let previousBalance: { amount: number; unit: string } | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let refreshQueued = false;

  const stopPolling = () => {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  };

  const abortAndClear = () => {
    activeRequest?.abort();
    activeRequest = undefined;
    refreshQueued = false;
  };

  const refreshBalance = async (showDelta = false) => {
    try {
      const ctx = currentCtx;
      if (!ctx) return;

      const version = ++requestVersion;
      const model = ctx.model;

      abortAndClear();

      if (!model) {
        ctx.ui.setStatus(STATUS_KEY, undefined);
        return;
      }

      const controller = new AbortController();
      activeRequest = controller;

      try {
        const result = await fetchProviderBalance(ctx, model, config, controller.signal);
        if (version !== requestVersion || controller.signal.aborted) return;

        if (result) {
          let statusText: string;
          if ("text" in result) {
            statusText = result.text;
          } else {
            const providerName =
              ctx.modelRegistry.getProviderDisplayName(model.provider) || model.provider;
            const balanceStr = formatBalance(result);

            // Compute delta vs previous balance
            let deltaPart = "";
            if (showDelta && previousBalance && !("text" in previousBalance)) {
              const delta = result.amount - previousBalance.amount;
              if (Math.abs(delta) >= 0.001) {
                const sign = delta > 0 ? "▲" : "▼";
                const color = delta > 0 ? "\u001b[34m" : "\u001b[31m";
                const reset = "\u001b[39m";
                const absDelta = formatNumber(Math.abs(delta), "0");
                const unit = result.unit || "$";
                deltaPart = ` ${color}${sign}${reset}${unit}${color}${absDelta}${reset}`;
              }
            }

            statusText = `${providerName}: ${balanceStr}${deltaPart}`;
          }
          ctx.ui.setStatus(STATUS_KEY, statusText);
        } else {
          ctx.ui.setStatus(STATUS_KEY, undefined);
        }

        // Update previous balance for next comparison
        if (result && !("text" in result)) {
          previousBalance = { amount: result.amount, unit: result.unit };
        }
      } catch {
        if (version === requestVersion) ctx.ui.setStatus(STATUS_KEY, undefined);
      } finally {
        if (version === requestVersion) {
          activeRequest = undefined;
          if (refreshQueued) {
            refreshQueued = false;
            refreshInBackground();
          }
        }
      }
    } catch (err) {
      // ctx is stale after session replacement/reload — stop
      if (err instanceof Error && err.message.includes("stale after session")) {
        currentCtx = undefined;
        stopPolling();
        requestVersion++;
        abortAndClear();
        return;
      }
      throw err;
    }
  };

  // Coalesce lifecycle events without aborting a request that is still fetching.
  // A queued refresh observes charges that may have arrived during that request.
  const refreshInBackground = () => {
    if (activeRequest) {
      refreshQueued = true;
      return;
    }
    void refreshBalance(true);
  };

  // ── Command registration ─────────────────────────────────

  pi.registerCommand("balance", {
    description: "pi-balance: status / enable|disable|toggle <provider> / sub2api / refresh / lang <zh-CN|en>",
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
      if (trimmed.startsWith("lang ")) {
        const partial = trimmed.slice("lang ".length);
        const langs = ["zh-CN", "en"];
        return langs
          .filter((l) => l.toLowerCase().startsWith(partial.toLowerCase()))
          .map((l) => ({ value: `lang ${l}`, label: `lang ${l}` }));
      }

      const commands = ["status", "refresh", "enable ", "disable ", "toggle ", "sub2api", "sub2api rescan", "lang "];
      return commands
        .filter((c) => c.startsWith(trimmed))
        .map((c) => ({ value: c, label: c }));
    },
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();

      currentCtx = ctx;
      config = loadConfig(ctx);

      // refresh
      if (action === "refresh") {
        previousBalance = undefined;
        await refreshBalance();
        ctx.ui.notify(t("balance_refreshed"), "info");
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
        ctx.ui.notify(t("sub2api_cache_cleared"), "info");
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
          ctx.ui.notify(t("unknown_provider", { name: providerArg }), "error");
          return;
        }
        config = setProviderEnabled(config, provider.key, true);
        persistConfig(pi, config);
        await refreshBalance();
        ctx.ui.notify(t("provider_enabled", { label: provider.definition.label }), "info");
        return;
      }

      // disable <provider>
      if (action.startsWith("disable ")) {
        const providerArg = action.slice("disable ".length);
        const provider = registry.findByFuzzyName(providerArg);
        if (!provider) {
          ctx.ui.notify(t("unknown_provider", { name: providerArg }), "error");
          return;
        }
        config = setProviderEnabled(config, provider.key, false);
        persistConfig(pi, config);
        await refreshBalance();
        ctx.ui.notify(t("provider_disabled", { label: provider.definition.label }), "info");
        return;
      }

      // toggle <provider>
      if (action.startsWith("toggle ")) {
        const providerArg = action.slice("toggle ".length);
        const provider = registry.findByFuzzyName(providerArg);
        if (!provider) {
          ctx.ui.notify(t("unknown_provider", { name: providerArg }), "error");
          return;
        }
        config = setProviderEnabled(
          config,
          provider.key,
          !isProviderEnabled(config, provider.key),
        );
        persistConfig(pi, config);
        ctx.ui.notify(
          t("provider_toggled", {
            label: provider.definition.label,
            status: isProviderEnabled(config, provider.key)
              ? t("status_enabled")
              : t("status_disabled"),
          }),
          "info",
        );
        return;
      }

      // lang <zh-CN|en> — switch language
      if (action.startsWith("lang ")) {
        const langArg = action.slice("lang ".length).trim();
        if (langArg === "zh-cn" || langArg === "zh" || langArg === "cn") {
          setLanguage("zh-CN");
          ctx.ui.notify(t("lang_switched_zh"), "info");
        } else if (langArg === "en" || langArg === "english") {
          setLanguage("en");
          ctx.ui.notify(t("lang_switched_en"), "info");
        } else {
          ctx.ui.notify(t("lang_unsupported", { name: langArg }), "error");
        }
        return;
      }

      // unknown → show status
      ctx.ui.notify(await buildSupportReport(ctx, config), "info");
    },
  });

  // ── Lifecycle events ────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    stopPolling();
    currentCtx = ctx;
    config = loadConfig(ctx);
    previousBalance = undefined;
    ctx.ui.setStatus(STATUS_KEY, undefined);
    void refreshBalance();
  });

  pi.on("model_select", async (_event, ctx) => {
    currentCtx = ctx;
    config = loadConfig(ctx);
    previousBalance = undefined;
    ctx.ui.setStatus(STATUS_KEY, undefined);
    void refreshBalance();
  });

  pi.on("agent_start", async (_event, ctx) => {
    currentCtx = ctx;
    stopPolling();
    refreshTimer = setInterval(() => {
      // Slow requests can outlast the interval, especially with CLI fallback.
      if (!activeRequest) refreshInBackground();
    }, REFRESH_INTERVAL_MS);
    refreshTimer.unref();
    refreshInBackground();
  });

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    currentCtx = ctx;
    refreshInBackground();
  });

  pi.on("agent_end", async (_event, ctx) => {
    currentCtx = ctx;
    stopPolling();
    refreshInBackground();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    currentCtx = undefined;
    stopPolling();
    requestVersion++;
    abortAndClear();
    try {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    } catch {
      // ctx may be stale after session replacement — ignore
    }
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

  // Try dedicated balance APIs before probing generic compatibility endpoints.
  const providers = [...registry.getAll()].sort(
    (a, b) => Number(a.key === "sub2api") - Number(b.key === "sub2api"),
  );

  for (const provider of providers) {
    if (signal?.aborted) return undefined;
    if (!isProviderEnabled(config, provider.key)) continue;
    if (!provider.shouldTry(model, baseUrl)) continue;
    const result = await provider.fetchBalance(context, signal);
    if (result) return result;
  }

  return undefined;
}
