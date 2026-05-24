import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type BalanceResult = {
  amount: number;
  unit: string;
};

type BalanceFetcher = (
  context: FetchContext,
  signal?: AbortSignal,
) => Promise<BalanceResult | undefined>;

type FetchContext = {
  model: Model<Api>;
  baseUrl: string;
  headers: Record<string, string>;
  config: BalanceConfig;
};

type ProviderKey = "deepseek" | "sub2api";

type ProviderDefinition = {
  key: ProviderKey;
  label: string;
  description: string;
  enabledByDefault: boolean;
};

type BalanceConfig = {
  disabledProviders: ProviderKey[];
  disabledSub2ApiProviders: string[];
};

type ProviderSupport = {
  provider: ProviderDefinition;
  configured: boolean;
  enabled: boolean;
  details: string[];
};

const STATUS_KEY = "provider-balance";
const REQUEST_TIMEOUT_MS = 8000;
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const CONFIG_ENTRY_TYPE = "pi-balance-config";
const DEFAULT_CONFIG: BalanceConfig = { disabledProviders: [], disabledSub2ApiProviders: [] };
const PROVIDERS: readonly ProviderDefinition[] = [
  {
    key: "deepseek",
    label: "DeepSeek",
    description: "DeepSeek /user/balance 余额",
    enabledByDefault: true,
  },
  {
    key: "sub2api",
    label: "Sub2Api",
    description: "Sub2Api /usage 剩余额度",
    enabledByDefault: true,
  },
];
const PROVIDER_BY_KEY = new Map(PROVIDERS.map((provider) => [provider.key, provider]));

const BALANCE_FETCHERS: readonly BalanceFetcher[] = [
  tryDeepSeekBalance,
  trySub2ApiBalance,
];

export default function (pi: ExtensionAPI) {
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let activeRequest: AbortController | undefined;
  let requestVersion = 0;
  let config = DEFAULT_CONFIG;

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

  const scheduleRefresh = (ctx: ExtensionContext) => {
    clearTimer();
    refreshTimer = setTimeout(() => {
      void refreshBalance(ctx);
    }, REFRESH_INTERVAL_MS);
  };

  const refreshBalance = async (ctx: ExtensionContext) => {
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
        const providerName =
          ctx.modelRegistry.getProviderDisplayName(model.provider) || model.provider;
        ctx.ui.setStatus(STATUS_KEY, `${providerName}: ${formatBalance(result)}`);
      } else {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
    } catch {
      if (version === requestVersion) {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
    } finally {
      if (version === requestVersion) {
        activeRequest = undefined;
        scheduleRefresh(ctx);
      }
    }
  };

  pi.registerCommand("balance", {
    description: "Configure pi-balance provider display and show support status",
    getArgumentCompletions: (prefix: string) => {
      const values = [
        "status",
        "enable",
        "disable",
        "toggle",
        "sub2api",
      ];
      const items = values
        .filter((value) => value.startsWith(prefix.trim()))
        .map((value) => ({ value, label: value }));

      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();

      config = loadConfig(ctx);

      if (action === "sub2api") {
        await openSub2ApiMenu(pi, ctx, config, async (nextConfig) => {
          config = nextConfig;
          persistConfig(pi, config);
          await refreshBalance(ctx);
        });
        return;
      }

      if (action.startsWith("enable ") || action.startsWith("disable ")) {
        const [verb, providerArg] = action.split(/\s+/, 2);
        const provider = findProvider(providerArg);

        if (!provider) {
          ctx.ui.notify(`未知 provider：${providerArg}`, "error");
          return;
        }

        config = setProviderEnabled(config, provider.key, verb === "enable");
        persistConfig(pi, config);
        await refreshBalance(ctx);
        ctx.ui.notify(`${provider.label} 已${verb === "enable" ? "开启" : "关闭"}显示`, "info");
        return;
      }

      if (action.startsWith("toggle ")) {
        const provider = findProvider(action.slice("toggle ".length));

        if (!provider) {
          ctx.ui.notify(`未知 provider：${action.slice("toggle ".length)}`, "error");
          return;
        }

        config = setProviderEnabled(config, provider.key, !isProviderEnabled(config, provider.key));
        persistConfig(pi, config);
        await refreshBalance(ctx);
        ctx.ui.notify(`${provider.label} 已${isProviderEnabled(config, provider.key) ? "开启" : "关闭"}显示`, "info");
        return;
      }

      if (ctx.hasUI && (action === "" || action === "config" || action === "menu")) {
        await openBalanceMenu(pi, ctx, config, async (nextConfig) => {
          config = nextConfig;
          persistConfig(pi, config);
          await refreshBalance(ctx);
        });
        return;
      }

      ctx.ui.notify(await buildSupportReport(ctx, config), "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    config = loadConfig(ctx);
    void refreshBalance(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    void refreshBalance(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopRefresh();
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}

function loadConfig(ctx: ExtensionContext): BalanceConfig {
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
  };
}

function persistConfig(pi: ExtensionAPI, config: BalanceConfig): void {
  pi.appendEntry(CONFIG_ENTRY_TYPE, config);
}

function isProviderKey(value: unknown): value is ProviderKey {
  return typeof value === "string" && PROVIDER_BY_KEY.has(value as ProviderKey);
}

function findProvider(value: string | undefined): ProviderDefinition | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;

  return PROVIDERS.find(
    (provider) =>
      provider.key === normalized ||
      provider.label.toLowerCase() === normalized ||
      provider.label.toLowerCase().startsWith(normalized),
  );
}

function isProviderEnabled(config: BalanceConfig, provider: ProviderKey): boolean {
  return !config.disabledProviders.includes(provider);
}

function setProviderEnabled(
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

function getEnabledFetchers(config: BalanceConfig): BalanceFetcher[] {
  const fetchers: Array<[ProviderKey, BalanceFetcher]> = [
    ["deepseek", tryDeepSeekBalance],
    ["sub2api", trySub2ApiBalance],
  ];

  return fetchers
    .filter(([provider]) => isProviderEnabled(config, provider))
    .map(([, fetcher]) => fetcher);
}

function isSub2ApiProviderEnabled(config: BalanceConfig, provider: string): boolean {
  return !config.disabledSub2ApiProviders.includes(provider);
}

function setSub2ApiProviderEnabled(
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

async function openBalanceMenu(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: BalanceConfig,
  onConfigChange: (config: BalanceConfig) => Promise<void>,
): Promise<void> {
  let sub2ApiExpanded = false;
  let deepSeekExpanded = false;

  while (true) {
    const supports = await getProviderSupports(ctx, config);
    const sub2ApiPrefix = sub2ApiExpanded ? "▼" : "▶";
    const deepSeekPrefix = deepSeekExpanded ? "▼" : "▶";
    const sub2ApiEnabled = isProviderEnabled(config, "sub2api");
    const deepSeekSupport = supports.find((support) => support.provider.key === "deepseek");
    const sub2ApiProviders = await getSub2ApiProviderCandidates(ctx);
    const sub2ApiDisplayOption = `  ${formatEnabled(sub2ApiEnabled)} Display`;
    const sub2ApiProviderOptions = new Map(
      sub2ApiProviders.map((provider) => [
        `  ${formatEnabled(isSub2ApiProviderEnabled(config, provider))} ${provider}`,
        provider,
      ]),
    );
    const deepSeekDisplayOption = deepSeekSupport
      ? `  ${formatEnabled(deepSeekSupport.enabled)} Display`
      : undefined;
    const options = [
      `${sub2ApiPrefix} Sub2Api`,
      ...(sub2ApiExpanded
        ? [
            sub2ApiDisplayOption,
            ...sub2ApiProviderOptions.keys(),
          ]
        : []),
      ...(deepSeekSupport
        ? [
            `${deepSeekPrefix} DeepSeek`,
            ...(deepSeekExpanded && deepSeekDisplayOption
              ? [deepSeekDisplayOption]
              : []),
          ]
        : []),
      "Back",
    ];
    const choice = await ctx.ui.select("pi-balance", options);
    if (!choice || choice === "Back") return;

    if (choice === `${sub2ApiPrefix} Sub2Api`) {
      sub2ApiExpanded = !sub2ApiExpanded;
      continue;
    }

    if (choice === `${deepSeekPrefix} DeepSeek`) {
      deepSeekExpanded = !deepSeekExpanded;
      continue;
    }

    if (choice === sub2ApiDisplayOption) {
      const nextConfig = setProviderEnabled(config, "sub2api", !sub2ApiEnabled);
      await onConfigChange(nextConfig);
      config = nextConfig;
      continue;
    }

    const provider = sub2ApiProviderOptions.get(choice);
    if (provider) {
      const nextConfig = setSub2ApiProviderEnabled(
        config,
        provider,
        !isSub2ApiProviderEnabled(config, provider),
      );
      await onConfigChange(nextConfig);
      config = nextConfig;
      continue;
    }
    if (choice === deepSeekDisplayOption && deepSeekSupport) {
      const nextConfig = setProviderEnabled(config, "deepseek", !deepSeekSupport.enabled);
      await onConfigChange(nextConfig);
      config = nextConfig;
      continue;
    }
  }
}
async function openSub2ApiMenu(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: BalanceConfig,
  onConfigChange: (config: BalanceConfig) => Promise<void>,
): Promise<void> {
  while (true) {
    const providers = await getSub2ApiProviderCandidates(ctx);
    const displayOption = `${formatEnabled(isProviderEnabled(config, "sub2api"))} Display`;
    const providerOptions = new Map(
      providers.map((provider) => [
        `${formatEnabled(isSub2ApiProviderEnabled(config, provider))} ${provider}`,
        provider,
      ]),
    );
    const options = [
      displayOption,
      ...providerOptions.keys(),
      "Back",
    ];
    const choice = await ctx.ui.select("pi-balance / Sub2Api", options);
    if (!choice || choice === "Back") return;

    if (choice === displayOption) {
      const nextConfig = setProviderEnabled(config, "sub2api", !isProviderEnabled(config, "sub2api"));
      await onConfigChange(nextConfig);
      config = nextConfig;
      continue;
    }

    const provider = providerOptions.get(choice);
    if (!provider) continue;

    const nextConfig = setSub2ApiProviderEnabled(
      config,
      provider,
      !isSub2ApiProviderEnabled(config, provider),
    );
    await onConfigChange(nextConfig);
    config = nextConfig;
  }
}

function summarizeSupports(supports: ProviderSupport[]): string {
  const ready = supports.filter((support) => support.configured).length;
  return `${ready}/${supports.length} ready`;
}

function formatEnabled(enabled: boolean): string {
  return enabled ? "◉" : "○";
}

async function getSub2ApiBadge(ctx: ExtensionContext, config: BalanceConfig): Promise<string> {
  const candidates = await getSub2ApiProviderCandidates(ctx);
  const enabled = candidates.filter((provider) => isSub2ApiProviderEnabled(config, provider)).length;
  return `${isProviderEnabled(config, "sub2api") ? "on" : "off"}, ${enabled}/${candidates.length}`;
}

let _validatedSub2ApiProviders: string[] | null = null;
let _sub2ApiProbePromise: Promise<string[]> | null = null;

async function probeSub2ApiProviders(ctx: ExtensionContext): Promise<string[]> {
  const modelsJsonPath = path.join(os.homedir(), ".pi", "agent", "models.json");
  const valid: string[] = [];

  let modelsConfig: any;
  try {
    modelsConfig = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
  } catch {
    return [];
  }

  const userProviders = modelsConfig.providers;
  if (!userProviders || typeof userProviders !== "object") return [];

  const allModels = ctx.modelRegistry.getAll();

  for (const [providerName, providerConfig] of Object.entries(userProviders)) {
    if (!providerConfig || typeof providerConfig !== "object") continue;

    const baseUrl = normalizeBaseUrl((providerConfig as any).baseUrl);
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
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        const response = await fetch(url, {
          method: "GET",
          headers,
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!response.ok) continue;

        const data = await response.json();
        if (extractRemaining(data as unknown) !== undefined) {
          valid.push(providerName);
          break;
        }
      } catch {
        continue;
      }
    }
  }

  return valid.sort((a, b) => a.localeCompare(b));
}

async function getSub2ApiProviderCandidates(ctx: ExtensionContext): Promise<string[]> {
  if (_validatedSub2ApiProviders !== null) {
    return _validatedSub2ApiProviders;
  }

  if (!_sub2ApiProbePromise) {
    _sub2ApiProbePromise = probeSub2ApiProviders(ctx);
  }

  const result = await _sub2ApiProbePromise;
  _validatedSub2ApiProviders = result;
  return result;
}
async function buildSupportReport(ctx: ExtensionContext, config: BalanceConfig): Promise<string> {
  return formatSupportReport(await getProviderSupports(ctx, config));
}

async function getProviderSupports(
  ctx: ExtensionContext,
  config: BalanceConfig,
): Promise<ProviderSupport[]> {
  const models = ctx.modelRegistry.getAll();
  const availableProviders = new Set(ctx.modelRegistry.getAvailable().map((model) => model.provider));
  const currentBaseUrl = normalizeBaseUrl(ctx.model?.baseUrl);
  const modelProviders = new Set(models.map((model) => model.provider));

  return PROVIDERS.map((provider) => {
    const details: string[] = [];
    let configured = false;

    if (provider.key === "deepseek") {
      const hasDeepSeekModel = models.some((model) =>
        normalizeBaseUrl(model.baseUrl)?.includes("deepseek.com"),
      );
      configured = availableProviders.has("deepseek") || hasDeepSeekModel;
      details.push(hasDeepSeekModel ? "已发现 DeepSeek 模型" : "未发现 DeepSeek 模型");
    }

    if (provider.key === "sub2api") {
      configured = Boolean(currentBaseUrl) || modelProviders.size > 0;
      details.push("兼容 API 会在当前模型 baseUrl 上尝试 /usage 与 /v1/usage");
    }


    return {
      provider,
      configured,
      enabled: isProviderEnabled(config, provider.key),
      details,
    };
  });
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
  const fetchers = getEnabledFetchers(config);

  for (const fetcher of fetchers) {
    if (signal?.aborted) return undefined;

    const result = await fetcher(context, signal);
    if (result) return result;
  }

  return undefined;
}


async function tryDeepSeekBalance(
  context: FetchContext,
  signal?: AbortSignal,
): Promise<BalanceResult | undefined> {
  const { baseUrl, headers } = context;
  const data = await getJson(`${getProviderRootUrl(baseUrl)}/user/balance`, headers, signal);
  const infos = getRecord(data)?.balance_infos;

  if (!Array.isArray(infos)) return undefined;

  let total = 0;
  let unit = "¥";
  let matched = false;

  for (const item of infos) {
    const record = getRecord(item);
    const amount = toNumber(record?.total_balance);

    if (amount === undefined) continue;

    matched = true;
    total += amount;

    const currency = typeof record?.currency === "string" ? record.currency : undefined;
    unit = currencyToUnit(currency) ?? currency ?? unit;
  }

  return matched ? { amount: total, unit } : undefined;
}

async function trySub2ApiBalance(
  context: FetchContext,
  signal?: AbortSignal,
): Promise<BalanceResult | undefined> {
  const { baseUrl, headers } = context;
  if (!isSub2ApiProviderEnabled(context.config, context.model.provider)) return undefined;

  for (const url of getSub2ApiUsageUrls(baseUrl)) {
    if (signal?.aborted) return undefined;

    const data = await getJson(url, headers, signal);
    const amount = extractRemaining(data);

    if (amount !== undefined) return { amount, unit: "$" };
  }

  return undefined;
}

async function getJson(
  url: string,
  headers: Record<string, string>,
  parentSignal?: AbortSignal,
): Promise<unknown> {
  if (parentSignal?.aborted) return undefined;

  const controller = new AbortController();
  const abort = () => controller.abort();
  const timeout = setTimeout(abort, REQUEST_TIMEOUT_MS);

  parentSignal?.addEventListener("abort", abort, { once: true });

  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    if (!response.ok) return undefined;

    return await response.json();
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", abort);
  }
}


function normalizeBaseUrl(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;

  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) return undefined;

  return trimmed.replace(/\/chat\/completions$/i, "").replace(/\/messages$/i, "");
}

function getProviderRootUrl(baseUrl: string): string {
  return baseUrl.replace(/\/v1$/i, "");
}

function getSub2ApiUsageUrls(baseUrl: string): string[] {
  const urls = [`${baseUrl}/usage`];

  if (/\/v1$/i.test(baseUrl)) {
    urls.push(`${getProviderRootUrl(baseUrl)}/usage`);
  } else {
    urls.push(`${baseUrl}/v1/usage`);
  }

  return [...new Set(urls)];
}


function extractRemaining(value: unknown): number | undefined {
  const record = getRecord(value);
  if (!record) return undefined;

  return (
    toNumber(record.remaining) ??
    toNumber(getRecord(record.data)?.remaining) ??
    toNumber(getRecord(record.usage)?.remaining)
  );
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;

  if (typeof value === "string") {
    const parsed = Number(value.trim().replace(/%$/, ""));
    if (Number.isFinite(parsed)) return parsed;
  }

  return undefined;
}

function hasHeader(headers: Record<string, string>, headerName: string): boolean {
  const normalizedHeaderName = headerName.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === normalizedHeaderName);
}
function currencyToUnit(currency: string | undefined): string | undefined {
  switch (currency?.toUpperCase()) {
    case "CNY":
      return "¥";
    case "USD":
      return "$";
    default:
      return undefined;
  }
}

function formatBalance(result: BalanceResult): string {
  const amount = result.amount.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  return result.unit === "$" ? `${result.unit}${amount}` : `${amount}${result.unit}`;
}