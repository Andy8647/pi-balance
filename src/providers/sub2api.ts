import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  BalanceResult,
  BalanceConfig,
  FetchContext,
  ProviderSupport,
} from "../types.js";
import {
  isSub2ApiProviderEnabled,
  setSub2ApiProviderEnabled,
  isProviderEnabled,
  setProviderEnabled,
} from "../config.js";
import {
  getJson,
  asString,
  normalizeBaseUrl,
  getRecord,
  toNumber,
  hasHeader,
} from "../utils.js";
import {
  MENU_COLOR_RESET,
  MENU_CURRENT_PROVIDER_COLOR,
  REQUEST_TIMEOUT_MS,
  SUB2API_PROBE_CACHE_TTL_MS,
} from "../types.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { BalanceProvider } from "./types.js";
import { registry } from "./registry.js";

// ══════════════════════════════════════════════════════════════

function formatCurrentProviderMenuText(text: string): string {
  return `${MENU_CURRENT_PROVIDER_COLOR}${text}${MENU_COLOR_RESET}`;
}
// Sub2Api: extract remaining from usage response
// ══════════════════════════════════════════════════════════════

export function extractRemaining(value: unknown): number | undefined {
  const record = getRecord(value);
  if (!record) return undefined;
  return (
    toNumber(record.remaining) ??
    toNumber(getRecord(record.data)?.remaining) ??
    toNumber(getRecord(record.usage)?.remaining)
  );
}

/** Build URLs to try for Sub2Api usage */
export function getSub2ApiUsageUrls(baseUrl: string): string[] {
  const urls = [`${baseUrl}/usage`];
  if (/\/v1$/i.test(baseUrl)) {
    urls.push(`${baseUrl.replace(/\/v1$/i, "")}/usage`);
  } else {
    urls.push(`${baseUrl}/v1/usage`);
  }
  return [...new Set(urls)];
}

// ══════════════════════════════════════════════════════════════
// Sub2Api provider probe (cached auto-discovery)
// ══════════════════════════════════════════════════════════════

let _validatedSub2ApiProviders: string[] | null = null;
let _sub2ApiProbePromise: Promise<string[]> | null = null;
let _sub2ApiProbeCachedAt = 0;

async function probeSub2ApiProviders(ctx: ExtensionContext): Promise<string[]> {
  const modelsJsonPath = path.join(os.homedir(), ".pi", "agent", "models.json");
  const valid: string[] = [];

  let modelsConfig: unknown;
  try {
    modelsConfig = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
  } catch {
    return [];
  }

  const modelsCfg = getRecord(modelsConfig);
  const userProviders = modelsCfg?.providers;
  if (!userProviders || typeof userProviders !== "object") return [];

  const allModels = ctx.modelRegistry.getAll();

  for (const [providerName, providerConfig] of Object.entries(userProviders)) {
    if (!providerConfig || typeof providerConfig !== "object") continue;

    const cfg = getRecord(providerConfig);
    const baseUrl = normalizeBaseUrl(asString(cfg?.baseUrl));
    if (!baseUrl) continue;

    const model = allModels.find((m) => m.provider === providerName);
    if (!model) continue;

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) continue;

    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(model.headers ?? {}),
      ...(auth.headers ?? {}),
    };
    if (auth.apiKey && !hasHeader(headers, "authorization")) {
      headers.Authorization = `Bearer ${auth.apiKey}`;
    }

    for (const url of getSub2ApiUsageUrls(baseUrl)) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const response = await fetch(url, {
          method: "GET",
          headers,
          signal: controller.signal,
        });

        if (!response.ok) continue;

        const data = await response.json();
        if (extractRemaining(data as unknown) !== undefined) {
          valid.push(providerName);
          break;
        }
      } catch {
        continue;
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  return valid.sort((a, b) => a.localeCompare(b));
}

export async function getSub2ApiProviderCandidates(ctx: ExtensionContext): Promise<string[]> {
  const now = Date.now();
  if (
    _validatedSub2ApiProviders !== null &&
    now - _sub2ApiProbeCachedAt < SUB2API_PROBE_CACHE_TTL_MS
  ) {
    return _validatedSub2ApiProviders;
  }

  if (!_sub2ApiProbePromise) {
    _sub2ApiProbePromise = probeSub2ApiProviders(ctx).finally(() => {
      _sub2ApiProbePromise = null;
    });
  }

  const result = await _sub2ApiProbePromise;
  _validatedSub2ApiProviders = result;
  _sub2ApiProbeCachedAt = Date.now();
  return result;
}

export function resetSub2ApiProbeCache(): void {
  _validatedSub2ApiProviders = null;
  _sub2ApiProbeCachedAt = 0;
  _sub2ApiProbePromise = null;
}

// ══════════════════════════════════════════════════════════════
// Sub2Api nested menu helpers
// ══════════════════════════════════════════════════════════════

function formatEnabled(enabled: boolean): string {
  return enabled ? "◉" : "○";
}

// ══════════════════════════════════════════════════════════════
// Sub2Api balance provider
// ══════════════════════════════════════════════════════════════

export const sub2apiProvider: BalanceProvider = {
  key: "sub2api",
  definition: {
    key: "sub2api",
    label: "Sub2Api",
    description: "Sub2Api /usage 剩余额度",
    enabledByDefault: true,
  },


  shouldTry(): boolean {
    // Sub2Api is always eligible for Sub2Api-compatible providers
    return true;
  },

  async fetchBalance(
    context: FetchContext,
    signal?: AbortSignal,
  ): Promise<BalanceResult | undefined> {
    const { baseUrl, headers, config } = context;
    if (!isSub2ApiProviderEnabled(config, context.model.provider)) return undefined;

    for (const url of getSub2ApiUsageUrls(baseUrl)) {
      if (signal?.aborted) return undefined;
      const data = await getJson(url, headers, signal);
      const amount = extractRemaining(data);
      if (amount !== undefined) return { amount, unit: "$" };
    }

    return undefined;
  },

  async getSupport(
    ctx: ExtensionContext,
    _config: BalanceConfig,
  ): Promise<ProviderSupport> {
    const availableModels = ctx.modelRegistry.getAvailable();
    const currentBaseUrl = normalizeBaseUrl(ctx.model?.baseUrl);
    const currentModelAvailable = Boolean(
      ctx.model && availableModels.some(
        (model) => model.provider === ctx.model?.provider && model.id === ctx.model?.id,
      ),
    );

    const configured = Boolean(currentBaseUrl && currentModelAvailable) || availableModels.length > 0;

    return {
      provider: this.definition,
      configured,
      enabled: true,
      details: [
        "兼容 API 会在当前模型 baseUrl 上尝试 /usage 与 /v1/usage",
        configured ? "至少一个模型认证可用" : "未发现可用模型认证",
      ],
    };
  },

  async openCustomSubMenu(
    _pi: ExtensionAPI,
    ctx: ExtensionContext,
    config: BalanceConfig,
    onConfigChange: (cfg: BalanceConfig) => Promise<void>,
  ): Promise<void> {
    let currentConfig = config;

    while (true) {
      const providers = await getSub2ApiProviderCandidates(ctx);
      const sub2apiEnabled = isProviderEnabled(currentConfig, "sub2api");
      const displayOption = `${formatEnabled(sub2apiEnabled)} Display`;
      const providerOptions = new Map(
        providers.map((provider) => {
          const enabled = isSub2ApiProviderEnabled(currentConfig, provider);
          const rawLabel = `${formatEnabled(enabled)} ${provider}`;
          const label = ctx.model?.provider === provider
            ? formatCurrentProviderMenuText(rawLabel)
            : rawLabel;
          return [label, provider];
        }),
      );
      const options = [
        "Rescan providers",
        displayOption,
        ...providerOptions.keys(),
        "Back",
      ];
      const choice = await ctx.ui.select("pi-balance / Sub2Api", options);
      if (!choice || choice === "Back") return;

      if (choice === "Rescan providers") {
        resetSub2ApiProbeCache();
        continue;
      }

      if (choice === displayOption) {
        const nextConfig = setProviderEnabled(
          currentConfig,
          "sub2api",
          !isProviderEnabled(currentConfig, "sub2api"),
        );
        await onConfigChange(nextConfig);
        currentConfig = nextConfig;
        continue;
      }

      const provider = providerOptions.get(choice);
      if (!provider) continue;

      const nextConfig = setSub2ApiProviderEnabled(
        currentConfig,
        provider,
        !isSub2ApiProviderEnabled(currentConfig, provider),
      );
      await onConfigChange(nextConfig);
      currentConfig = nextConfig;
    }
  },
};

registry.register(sub2apiProvider);
