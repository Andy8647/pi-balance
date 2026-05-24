import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type BalanceResult =
  | {
      amount: number;
      unit: string;
    }
  | {
      text: string;
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

type ProviderKey = "deepseek" | "sub2api" | "codex" | "moonshot";

type ProviderDefinition = {
  key: ProviderKey;
  label: string;
  description: string;
  enabledByDefault: boolean;
};

type BalanceConfig = {
  disabledProviders: ProviderKey[];
  disabledSub2ApiProviders: string[];
  codexAppServerFallback: boolean;
};

type ProviderSupport = {
  provider: ProviderDefinition;
  configured: boolean;
  enabled: boolean;
  details: string[];
};

type BalanceFetcherEntry = {
  provider: ProviderKey;
  fetcher: BalanceFetcher;
};

const STATUS_KEY = "provider-balance";
const REQUEST_TIMEOUT_MS = 8000;
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const CONFIG_ENTRY_TYPE = "pi-balance-config";
const DEFAULT_CONFIG: BalanceConfig = {
  disabledProviders: [],
  disabledSub2ApiProviders: [],
  codexAppServerFallback: true,
};
const CODEX_PROVIDER_ID = "openai-codex";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_APP_SERVER_TIMEOUT_MS = 15000;
const CODEX_STATUS_PREFIX = "📊 codex";
const MAX_ERROR_BODY_CHARS = 600;
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const SUB2API_PROBE_CACHE_TTL_MS = 60 * 1000;
const MENU_UNAVAILABLE_COLOR = "\u001b[90m";
const MENU_MUTED_COLOR = "\u001b[90m";
const MENU_COLOR_RESET = "\u001b[39m";

type CodexUsageReport = {
  source: "pi-auth" | "codex-app-server";
  capturedAt: number;
  planType?: string;
  snapshots: NormalizedRateLimitSnapshot[];
};

type NormalizedRateLimitSnapshot = {
  limitId: string;
  limitName?: string;
  primary?: NormalizedRateLimitWindow;
  secondary?: NormalizedRateLimitWindow;
  credits?: NormalizedCredits;
};

type NormalizedRateLimitWindow = {
  usedPercent: number;
  windowMinutes?: number;
  resetsAt?: number;
};

type NormalizedCredits = {
  hasCredits: boolean;
  unlimited: boolean;
  balance?: string;
};

type PendingRpc = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type RpcResponse = {
  id?: unknown;
  result?: unknown;
  error?: { message?: unknown };
};
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
  {
    key: "codex",
    label: "OpenAI Codex",
    description: "OpenAI Codex ChatGPT 订阅用量",
    enabledByDefault: true,
  },
  {
    key: "moonshot",
    label: "Moonshot",
    description: "Moonshot /v1/users/me/balance 余额",
    enabledByDefault: true,
  },
];
const PROVIDER_BY_KEY = new Map(PROVIDERS.map((provider) => [provider.key, provider]));

const BALANCE_FETCHERS: readonly BalanceFetcherEntry[] = [
  { provider: "deepseek", fetcher: tryDeepSeekBalance },
  { provider: "moonshot", fetcher: tryMoonshotBalance },
  { provider: "sub2api", fetcher: trySub2ApiBalance },
  { provider: "codex", fetcher: tryCodexUsage },
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
        "refresh",
        "enable",
        "disable",
        "toggle",
        "sub2api",
        "sub2api rescan",
      ];
      const items = values
        .filter((value) => value.startsWith(prefix.trim()))
        .map((value) => ({ value, label: value }));

      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();

      config = loadConfig(ctx);

      if (action === "refresh") {
        await refreshBalance(ctx);
        ctx.ui.notify("余额状态已刷新", "info");
        return;
      }

      if (action === "sub2api rescan" || action === "rescan sub2api") {
        resetSub2ApiProbeCache();
        ctx.ui.notify("Sub2Api provider 探测缓存已清空，将重新扫描", "info");
        await openSub2ApiMenu(pi, ctx, config, async (nextConfig) => {
          config = nextConfig;
          persistConfig(pi, config);
          await refreshBalance(ctx);
        });
        return;
      }

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
    codexAppServerFallback: record?.codexAppServerFallback !== false,
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

function getEnabledFetchers(config: BalanceConfig, model: Model<Api>, baseUrl: string): BalanceFetcher[] {
  return BALANCE_FETCHERS
    .filter(({ provider }) => isProviderEnabled(config, provider))
    .filter(({ provider }) => shouldTryProvider(provider, model, baseUrl))
    .map(({ fetcher }) => fetcher);
}

function shouldTryProvider(provider: ProviderKey, model: Model<Api>, baseUrl: string): boolean {
  if (provider === "codex") return model.provider === CODEX_PROVIDER_ID;
  if (model.provider === CODEX_PROVIDER_ID) return false;
  if (provider === "deepseek") {
    return model.provider === "deepseek" || getProviderRootUrl(baseUrl).includes("deepseek.com");
  }
  if (provider === "moonshot") {
    return model.provider === "moonshot" || getProviderRootUrl(baseUrl).includes("moonshot.cn");
  }
  return true;
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
  let codexExpanded = false;
  let moonshotExpanded = false;

  while (true) {
    const supports = await getProviderSupports(ctx, config);
    const sub2ApiPrefix = sub2ApiExpanded ? "▼" : "▶";
    const deepSeekPrefix = deepSeekExpanded ? "▼" : "▶";
    const codexPrefix = codexExpanded ? "▼" : "▶";
    const moonshotPrefix = moonshotExpanded ? "▼" : "▶";
    const sub2ApiSupport = supports.find((support) => support.provider.key === "sub2api");
    const deepSeekSupport = supports.find((support) => support.provider.key === "deepseek");
    const codexSupport = supports.find((support) => support.provider.key === "codex");
    const moonshotSupport = supports.find((support) => support.provider.key === "moonshot");
    const sub2ApiEnabled = sub2ApiSupport?.enabled ?? isProviderEnabled(config, "sub2api");
    const sub2ApiProviders = await getSub2ApiProviderCandidates(ctx);
    const sub2ApiMenuOption = getProviderMenuOption(sub2ApiPrefix, "Sub2Api", sub2ApiSupport);
    const deepSeekMenuOption = getProviderMenuOption(deepSeekPrefix, "DeepSeek", deepSeekSupport);
    const codexMenuOption = getProviderMenuOption(codexPrefix, "OpenAI Codex", codexSupport);
    const moonshotMenuOption = getProviderMenuOption(moonshotPrefix, "Moonshot", moonshotSupport);
    const sub2ApiDisplayOption = getProviderActionOption(
      "sub2api-display",
      getProviderActionLabel(formatEnabled(sub2ApiEnabled), "Display", "Sub2Api"),
      sub2ApiSupport,
    );
    const sub2ApiProviderOptions = new Map(
      sub2ApiProviders.map((provider) => [
        `  ${formatEnabled(isSub2ApiProviderEnabled(config, provider))} ${provider}`,
        provider,
      ]),
    );
    const deepSeekDisplayOption = getProviderActionOption(
      "deepseek-display",
      getProviderActionLabel(formatEnabled(deepSeekSupport?.enabled ?? false), "Display", "DeepSeek"),
      deepSeekSupport,
    );
    const codexDisplayOption = getProviderActionOption(
      "codex-display",
      getProviderActionLabel(formatEnabled(codexSupport?.enabled ?? false), "Display", "OpenAI Codex"),
      codexSupport,
    );
    const codexFallbackOption = codexSupport
      ? getProviderActionOption(
          "codex-cli-fallback",
          getProviderActionLabel(formatEnabled(config.codexAppServerFallback), "CLI fallback", "OpenAI Codex"),
          codexSupport,
        )
      : undefined;
    const moonshotDisplayOption = getProviderActionOption(
      "moonshot-display",
      getProviderActionLabel(formatEnabled(moonshotSupport?.enabled ?? false), "Display", "Moonshot"),
      moonshotSupport,
    );
    const options: MenuOption[] = [
      { label: "Refresh", value: "Refresh", choice: "Refresh" },
      sub2ApiMenuOption,
      ...(sub2ApiExpanded
        ? [
            sub2ApiDisplayOption,
            ...[...sub2ApiProviderOptions.keys()].map((label) => ({ label, value: label, choice: label })),
          ]
        : []),
      ...(
        deepSeekSupport
          ? [
              deepSeekMenuOption,
              ...(deepSeekExpanded ? [deepSeekDisplayOption] : []),
            ]
          : []
      ),
      ...(
        codexSupport
          ? [
              codexMenuOption,
              ...(codexExpanded ? [codexDisplayOption] : []),
              ...(codexExpanded && codexFallbackOption ? [codexFallbackOption] : []),
            ]
          : []
      ),
      ...(
        moonshotSupport
          ? [
              moonshotMenuOption,
              ...(moonshotExpanded ? [moonshotDisplayOption] : []),
            ]
          : []
      ),
      { label: "Back", value: "Back", choice: "Back" },
    ];
    const optionChoices = new Map(options.map((option) => [option.value, option.choice]));
    const choiceValue = await ctx.ui.select("pi-balance", options.map((option) => option.value));
    const choice = choiceValue ? optionChoices.get(choiceValue) : undefined;
    if (!choice || choice === "Back") return;

    if (choice === "Refresh") {
      await onConfigChange(config);
      continue;
    }

    if (choice === sub2ApiMenuOption.choice) {
      const nextExpanded: boolean = !sub2ApiExpanded;
      sub2ApiExpanded = nextExpanded;
      deepSeekExpanded = false;
      codexExpanded = false;
      moonshotExpanded = false;
      continue;
    }

    if (choice === deepSeekMenuOption.choice) {
      const nextExpanded: boolean = !deepSeekExpanded;
      sub2ApiExpanded = false;
      deepSeekExpanded = nextExpanded;
      codexExpanded = false;
      moonshotExpanded = false;
      continue;
    }

    if (choice === codexMenuOption.choice) {
      const nextExpanded: boolean = !codexExpanded;
      sub2ApiExpanded = false;
      deepSeekExpanded = false;
      codexExpanded = nextExpanded;
      moonshotExpanded = false;
      continue;
    }

    if (choice === moonshotMenuOption.choice) {
      const nextExpanded: boolean = !moonshotExpanded;
      sub2ApiExpanded = false;
      deepSeekExpanded = false;
      codexExpanded = false;
      moonshotExpanded = nextExpanded;
      continue;
    }

    if (choice === sub2ApiDisplayOption.choice && sub2ApiSupport?.configured) {
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
    if (choice === deepSeekDisplayOption.choice && deepSeekSupport?.configured) {
      const nextConfig = setProviderEnabled(config, "deepseek", !deepSeekSupport.enabled);
      await onConfigChange(nextConfig);
      config = nextConfig;
      continue;
    }

    if (choice === codexDisplayOption.choice && codexSupport?.configured) {
      const nextConfig = setProviderEnabled(config, "codex", !codexSupport.enabled);
      await onConfigChange(nextConfig);
      config = nextConfig;
      continue;
    }

    if (choice === moonshotDisplayOption.choice && moonshotSupport?.configured) {
      const nextConfig = setProviderEnabled(config, "moonshot", !moonshotSupport.enabled);
      await onConfigChange(nextConfig);
      config = nextConfig;
      continue;
    }

    if (codexFallbackOption && choice === codexFallbackOption.choice && codexSupport?.configured) {
      const nextConfig = { ...config, codexAppServerFallback: !config.codexAppServerFallback };
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

type MenuOption = {
  label: string;
  value: string;
  choice: string;
};

function formatUnavailableMenuLabel(label: string): string {
  return `${MENU_UNAVAILABLE_COLOR}${label}${MENU_COLOR_RESET}`;
}

function formatMutedMenuText(text: string): string {
  return `${MENU_MUTED_COLOR}${text}${MENU_COLOR_RESET}`;
}

function getProviderActionLabel(icon: string, action: string, provider: string): string {
  return `  ${icon} ${action}${formatMutedMenuText(` - ${provider}`)}`;
}

function getProviderUnavailableReason(support: ProviderSupport | undefined): string {
  if (!support) return "未就绪";
  const unavailableDetail = support.details.find((detail) => detail.includes("不可用") || detail.includes("未发现"));
  return unavailableDetail ?? "未就绪";
}

function getProviderMenuText(prefix: string, label: string, support: ProviderSupport | undefined): string {
  const configured = support?.configured ?? false;
  const suffix = configured ? "" : ` (${getProviderUnavailableReason(support)})`;
  return `${prefix} ${label}${suffix}`;
}

function getProviderMenuOption(prefix: string, label: string, support: ProviderSupport | undefined): MenuOption {
  const text = getProviderMenuText(prefix, label, support);
  const labelText = support?.configured ?? false ? text : formatUnavailableMenuLabel(text);
  return {
    choice: text,
    label: labelText,
    value: labelText,
  };
}

function getProviderActionOption(choice: string, label: string, support: ProviderSupport | undefined): MenuOption {
  const labelText = support?.configured ?? false ? label : formatUnavailableMenuLabel(label);
  return {
    choice,
    label: labelText,
    value: labelText,
  };
}

async function getSub2ApiBadge(ctx: ExtensionContext, config: BalanceConfig): Promise<string> {
  const candidates = await getSub2ApiProviderCandidates(ctx);
  const enabled = candidates.filter((provider) => isSub2ApiProviderEnabled(config, provider)).length;
  return `${isProviderEnabled(config, "sub2api") ? "on" : "off"}, ${enabled}/${candidates.length}`;
}

let _validatedSub2ApiProviders: string[] | null = null;
let _sub2ApiProbePromise: Promise<string[]> | null = null;
let _sub2ApiProbeCachedAt = 0;

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

async function getSub2ApiProviderCandidates(ctx: ExtensionContext): Promise<string[]> {
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

function resetSub2ApiProbeCache(): void {
  _validatedSub2ApiProviders = null;
  _sub2ApiProbeCachedAt = 0;
  _sub2ApiProbePromise = null;
}
async function buildSupportReport(ctx: ExtensionContext, config: BalanceConfig): Promise<string> {
  return formatSupportReport(await getProviderSupports(ctx, config));
}

async function getProviderSupports(
  ctx: ExtensionContext,
  config: BalanceConfig,
): Promise<ProviderSupport[]> {
  const models = ctx.modelRegistry.getAll();
  const availableModels = ctx.modelRegistry.getAvailable();
  const availableProviders = new Set(availableModels.map((model) => model.provider));
  const currentBaseUrl = normalizeBaseUrl(ctx.model?.baseUrl);
  const currentModelAvailable = Boolean(
    ctx.model && availableModels.some((model) => model.provider === ctx.model?.provider && model.id === ctx.model?.id),
  );

  return PROVIDERS.map((provider) => {
    const details: string[] = [];
    let configured = false;

    if (provider.key === "deepseek") {
      const hasDeepSeekModel = models.some((model) =>
        model.provider === "deepseek" || normalizeBaseUrl(model.baseUrl)?.includes("deepseek.com"),
      );
      configured = availableModels.some((model) =>
        model.provider === "deepseek" || normalizeBaseUrl(model.baseUrl)?.includes("deepseek.com"),
      );
      details.push(hasDeepSeekModel ? "已发现 DeepSeek 模型" : "未发现 DeepSeek 模型");
      details.push(configured ? "DeepSeek 认证可用" : "DeepSeek 认证不可用");
    }

    if (provider.key === "sub2api") {
      configured = Boolean(currentBaseUrl && currentModelAvailable) || availableModels.length > 0;
      details.push("兼容 API 会在当前模型 baseUrl 上尝试 /usage 与 /v1/usage");
      details.push(configured ? "至少一个模型认证可用" : "未发现可用模型认证");
    }

    if (provider.key === "codex") {
      const hasCodexModel = models.some((model) => model.provider === CODEX_PROVIDER_ID);
      configured = availableProviders.has(CODEX_PROVIDER_ID);
      details.push(hasCodexModel ? "已发现 OpenAI Codex 模型" : "未发现 OpenAI Codex 模型");
      details.push(configured ? "OpenAI Codex 认证可用" : "OpenAI Codex 认证不可用");
      details.push(
        config.codexAppServerFallback
          ? "会优先复用 Pi 的 Codex 订阅认证，必要时回退到 codex app-server"
          : "会仅复用 Pi 的 Codex 订阅认证；codex app-server 回退已关闭",
      );
    }
    if (provider.key === "moonshot") {
      const hasMoonshotModel = models.some((model) =>
        model.provider === "moonshot" || normalizeBaseUrl(model.baseUrl)?.includes("moonshot.cn"),
      );
      configured = availableModels.some((model) =>
        model.provider === "moonshot" || normalizeBaseUrl(model.baseUrl)?.includes("moonshot.cn"),
      );
      details.push(hasMoonshotModel ? "已发现 Moonshot 模型" : "未发现 Moonshot 模型");
      details.push(configured ? "Moonshot 认证可用" : "Moonshot 认证不可用");
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
  const fetchers = getEnabledFetchers(config, model, baseUrl);

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

async function tryCodexUsage(
  context: FetchContext,
  signal?: AbortSignal,
): Promise<BalanceResult | undefined> {
  if (context.model.provider !== CODEX_PROVIDER_ID) return undefined;

  const report =
    (await queryCodexUsageViaPiAuth(context.headers, signal)) ??
    (context.config.codexAppServerFallback
      ? await queryCodexUsageViaAppServer(signal)
      : undefined);

  return report ? { text: formatCodexUsageStatusline(report, context.model) } : undefined;
}

async function tryMoonshotBalance(
  context: FetchContext,
  signal?: AbortSignal,
): Promise<BalanceResult | undefined> {
  const { baseUrl, headers } = context;
  const data = await getJson(`${getProviderRootUrl(baseUrl)}/v1/users/me/balance`, headers, signal);
  const amount = extractMoonshotAvailableBalance(data);
  if (amount === undefined) return undefined;

  return { amount, unit: "¥" };
}

async function queryCodexUsageViaPiAuth(
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<CodexUsageReport | undefined> {
  if (!hasHeader(headers, "authorization")) return undefined;

  const codexHeaders = buildCodexBackendHeaders(headers);
  if (!codexHeaders) return undefined;

  const data = await getJsonWithTimeout(CODEX_USAGE_URL, codexHeaders, CODEX_APP_SERVER_TIMEOUT_MS, signal);
  const payload = getRecord(data);
  if (!payload) return undefined;

  return normalizeBackendPayload(payload, Date.now(), "pi-auth");
}

async function queryCodexUsageViaAppServer(signal?: AbortSignal): Promise<CodexUsageReport | undefined> {
  const client = new CodexAppServerClient(CODEX_APP_SERVER_TIMEOUT_MS, signal);
  try {
    await client.start();
    await client.request("initialize", {
      clientInfo: { name: "pi_balance", title: "Pi Balance", version: "0.2.1" },
      capabilities: {
        experimentalApi: false,
        optOutNotificationMethods: [],
      },
    });
    client.notify("initialized");
    const result = await client.request("account/rateLimits/read", undefined);
    const payload = getRecord(result);
    return payload ? normalizeAppServerResponse(payload, Date.now()) : undefined;
  } catch {
    return undefined;
  } finally {
    client.dispose();
  }
}

class CodexAppServerClient {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private stderr = "";
  private readonly pending = new Map<number, PendingRpc>();
  private startPromise?: Promise<void>;
  private exitError?: Error;

  constructor(
    private readonly timeoutMs: number,
    private readonly signal?: AbortSignal,
  ) {}

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;

    this.startPromise = new Promise((resolve, reject) => {
      if (this.signal?.aborted) {
        reject(new Error("Codex usage request aborted."));
        return;
      }

      const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.child = child;

      const startupTimeout = setTimeout(() => {
        reject(new Error(`Timed out after ${Math.round(this.timeoutMs / 1000)}s starting codex app-server.`));
      }, this.timeoutMs);

      const cleanup = () => {
        clearTimeout(startupTimeout);
        this.signal?.removeEventListener("abort", abort);
      };
      const abort = () => {
        cleanup();
        this.dispose();
        reject(new Error("Codex usage request aborted."));
      };
      this.signal?.addEventListener("abort", abort, { once: true });

      child.once("spawn", () => {
        cleanup();
        resolve();
      });

      child.once("error", (error) => {
        cleanup();
        reject(new Error(`Failed to start codex app-server: ${error.message}`));
        this.rejectAll(error);
      });

      child.once("exit", (code, signalName) => {
        const suffix = this.stderr ? ` stderr: ${redactErrorBody(this.stderr)}` : "";
        this.exitError = new Error(
          `codex app-server exited before completing the request (code ${code ?? "unknown"}, signal ${signalName ?? "none"}).${suffix}`,
        );
        this.rejectAll(this.exitError);
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        this.stderr = truncateEnd(this.stderr + chunk, MAX_ERROR_BODY_CHARS);
      });

      createInterface({ input: child.stdout }).on("line", (line) => this.handleLine(line));
    });

    return this.startPromise;
  }

  request(method: string, params: unknown): Promise<unknown> {
    const child = this.child;
    if (!child?.stdin.writable) throw new Error("codex app-server is not running.");
    if (this.exitError) throw this.exitError;

    const id = this.nextId++;
    const payload = params === undefined ? { method, id } : { method, id, params };
    const response = new Promise<unknown>((resolve: (value: unknown) => void, reject: (error: Error) => void) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out after ${Math.round(this.timeoutMs / 1000)}s waiting for ${method}.`));
      }, this.timeoutMs);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });

    child.stdin.write(`${JSON.stringify(payload)}\n`);
    return response;
  }

  notify(method: string): void {
    const child = this.child;
    if (!child?.stdin.writable) return;
    child.stdin.write(`${JSON.stringify({ method })}\n`);
  }

  dispose(): void {
    for (const [id, pending] of this.pending) {
      pending.reject(new Error(`codex app-server request ${id} cancelled.`));
    }
    this.pending.clear();

    const child = this.child;
    if (!child) return;
    child.stdin.end();
    if (!child.killed) child.kill();
    this.child = undefined;
  }

  private handleLine(line: string): void {
    let parsed: RpcResponse;
    try {
      parsed = JSON.parse(line) as RpcResponse;
    } catch {
      return;
    }

    if (typeof parsed.id !== "number") return;
    const pending = this.pending.get(parsed.id);
    if (!pending) return;
    this.pending.delete(parsed.id);

    if (parsed.error) {
      const message = typeof parsed.error.message === "string" ? parsed.error.message : "unknown error";
      pending.reject(new Error(`codex app-server request failed: ${message}`));
      return;
    }

    pending.resolve(parsed.result);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

export function normalizeBackendPayload(
  payload: Record<string, unknown>,
  capturedAt: number,
  source: "pi-auth" | "codex-app-server",
): CodexUsageReport | undefined {
  const snapshots: NormalizedRateLimitSnapshot[] = [];
  const primary = normalizeBackendSnapshot("codex", undefined, payload.rate_limit, payload.credits);
  if (primary) snapshots.push(primary);

  const additional = Array.isArray(payload.additional_rate_limits) ? payload.additional_rate_limits : [];
  for (const item of additional) {
    const additionalLimit = getRecord(item);
    if (!additionalLimit) continue;
    const limitId = asString(additionalLimit.metered_feature) ?? asString(additionalLimit.limit_name);
    if (!limitId) continue;
    const snapshot = normalizeBackendSnapshot(
      limitId,
      asString(additionalLimit.limit_name),
      additionalLimit.rate_limit,
      undefined,
    );
    if (snapshot) snapshots.push(snapshot);
  }

  return snapshots.length > 0
    ? { source, capturedAt, planType: asString(payload.plan_type), snapshots }
    : undefined;
}

function normalizeBackendSnapshot(
  limitId: string,
  limitName: string | undefined,
  rateLimit: unknown,
  credits: unknown,
): NormalizedRateLimitSnapshot | undefined {
  const details = getRecord(rateLimit);
  const primary = details ? normalizeBackendWindow(details.primary_window) : undefined;
  const secondary = details ? normalizeBackendWindow(details.secondary_window) : undefined;
  const normalizedCredits = normalizeCredits(credits, "backend");
  if (!primary && !secondary && !normalizedCredits) return undefined;
  return { limitId, limitName, primary, secondary, credits: normalizedCredits };
}

function normalizeBackendWindow(value: unknown): NormalizedRateLimitWindow | undefined {
  const window = getRecord(value);
  if (!window) return undefined;
  const usedPercent = toNumber(window.used_percent);
  if (usedPercent === undefined) return undefined;
  const limitSeconds = toNumber(window.limit_window_seconds);
  return {
    usedPercent,
    windowMinutes: limitSeconds && limitSeconds > 0 ? Math.ceil(limitSeconds / 60) : undefined,
    resetsAt: toNumber(window.reset_at),
  };
}

export function normalizeAppServerResponse(
  response: Record<string, unknown>,
  capturedAt: number,
): CodexUsageReport | undefined {
  const snapshots: NormalizedRateLimitSnapshot[] = [];
  const addSnapshot = (raw: unknown, fallbackId: string) => {
    const snapshot = normalizeAppServerSnapshot(raw, fallbackId);
    if (!snapshot) return;
    const index = snapshots.findIndex((item) => item.limitId === snapshot.limitId);
    if (index >= 0) snapshots[index] = { ...snapshots[index], ...snapshot };
    else snapshots.push(snapshot);
  };

  addSnapshot(response.rateLimits, "codex");
  const byId = getRecord(response.rateLimitsByLimitId);
  if (byId) {
    for (const [limitId, raw] of Object.entries(byId)) addSnapshot(raw, limitId);
  }

  return snapshots.length > 0
    ? {
        source: "codex-app-server",
        capturedAt,
        planType: asString(getRecord(response.rateLimits)?.planType),
        snapshots,
      }
    : undefined;
}

function normalizeAppServerSnapshot(
  raw: unknown,
  fallbackId: string,
): NormalizedRateLimitSnapshot | undefined {
  const snapshot = getRecord(raw);
  if (!snapshot) return undefined;
  const primary = normalizeAppServerWindow(snapshot.primary);
  const secondary = normalizeAppServerWindow(snapshot.secondary);
  const credits = normalizeCredits(snapshot.credits, "app-server");
  if (!primary && !secondary && !credits) return undefined;
  return {
    limitId: asString(snapshot.limitId) ?? fallbackId,
    limitName: asString(snapshot.limitName),
    primary,
    secondary,
    credits,
  };
}

function normalizeAppServerWindow(value: unknown): NormalizedRateLimitWindow | undefined {
  const window = getRecord(value);
  if (!window) return undefined;
  const usedPercent = toNumber(window.usedPercent);
  if (usedPercent === undefined) return undefined;
  return {
    usedPercent,
    windowMinutes: toNumber(window.windowDurationMins),
    resetsAt: toNumber(window.resetsAt),
  };
}

function normalizeCredits(value: unknown, source: "backend" | "app-server"): NormalizedCredits | undefined {
  const credits = getRecord(value);
  if (!credits) return undefined;
  const hasCredits = asBoolean(source === "backend" ? credits.has_credits : credits.hasCredits);
  const unlimited = asBoolean(credits.unlimited);
  if (hasCredits === undefined || unlimited === undefined) return undefined;
  return { hasCredits, unlimited, balance: asString(credits.balance) };
}

export function formatCodexUsageStatusline(
  report: CodexUsageReport,
  model?: Pick<Model<Api>, "id" | "name" | "provider">,
): string {
  const snapshot = selectCodexSnapshot(report, model);
  if (!snapshot) return `${CODEX_STATUS_PREFIX} unavailable`;

  const parts = [`${CODEX_STATUS_PREFIX}${formatCodexStatuslineSuffix(snapshot)}`];
  if (snapshot.primary) parts.push(`${formatRemainingPercent(snapshot.primary)} 5h`);
  if (snapshot.secondary) parts.push(`${formatRemainingPercent(snapshot.secondary)} wk`);
  if (parts.length === 1 && snapshot.credits) parts.push(formatCredits(snapshot.credits));
  return parts.join(" ");
}

export function selectCodexSnapshot(
  report: CodexUsageReport,
  model?: Pick<Model<Api>, "id" | "name" | "provider">,
): NormalizedRateLimitSnapshot | undefined {
  const primary = report.snapshots.find(isPrimaryCodexSnapshot);
  if (!model || model.provider !== CODEX_PROVIDER_ID) return primary ?? report.snapshots[0];

  const keys = normalizedModelUsageKeys(model);
  const exact = report.snapshots.find((snapshot) =>
      !isPrimaryCodexSnapshot(snapshot) &&
      normalizedSnapshotUsageKeys(snapshot).some((key) => keys.has(key)),
  );
  if (exact) return exact;

  for (const variant of codexModelVariantKeys(keys)) {
    const matches = report.snapshots.filter(
      (snapshot) =>
        !isPrimaryCodexSnapshot(snapshot) &&
        normalizedSnapshotUsageKeys(snapshot).some((key) => normalizedKeyHasToken(key, variant)),
    );
    if (matches.length === 1) return matches[0];
  }

  return primary ?? report.snapshots[0];
}

function normalizedModelUsageKeys(model: Pick<Model<Api>, "id" | "name">): Set<string> {
  const keys = new Set<string>();
  addNormalizedUsageKey(keys, model.id);
  addNormalizedUsageKey(keys, model.name);

  for (const key of [...keys]) {
    const codexIndex = key.indexOf("codex");
    if (codexIndex >= 0) keys.add(key.slice(codexIndex));
  }

  return keys;
}

function addNormalizedUsageKey(keys: Set<string>, value: string | undefined): void {
  const key = normalizedUsageKey(value);
  if (key) keys.add(key);
}

function normalizedSnapshotUsageKeys(snapshot: NormalizedRateLimitSnapshot): string[] {
  return [normalizedUsageKey(snapshot.limitId), normalizedUsageKey(snapshot.limitName)].filter(
    (key): key is string => key !== undefined,
  );
}

function normalizedUsageKey(value: string | undefined): string | undefined {
  const key = value
    ?.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return key || undefined;
}

function codexModelVariantKeys(modelKeys: Set<string>): string[] {
  const variants = new Set<string>();
  for (const key of modelKeys) {
    const match = key.match(/(?:^|-)codex-(.+)$/);
    if (match?.[1]) variants.add(match[1]);
  }
  return [...variants];
}

function normalizedKeyHasToken(key: string, token: string): boolean {
  return key === token || key.startsWith(`${token}-`) || key.endsWith(`-${token}`) || key.includes(`-${token}-`);
}

function formatCodexStatuslineSuffix(snapshot: NormalizedRateLimitSnapshot): string {
  if (isPrimaryCodexSnapshot(snapshot)) return "";
  const label = snapshot.limitName ?? snapshot.limitId;
  const normalized = label.replace(/[_-]+/g, " ").trim();
  const codexVariant = normalized.match(/\bcodex\s+(.+)$/i)?.[1]?.trim();
  const compact = (codexVariant || normalized).toLowerCase().replace(/\s+/g, " ");
  return compact ? ` ${compact}` : "";
}

function isPrimaryCodexSnapshot(snapshot: NormalizedRateLimitSnapshot): boolean {
  return normalizedUsageKey(snapshot.limitId) === "codex" || normalizedUsageKey(snapshot.limitName) === "codex";
}

function formatRemainingPercent(window: NormalizedRateLimitWindow): string {
  return `${(100 - clampPercent(window.usedPercent)).toFixed(0)}%`;
}

function formatCredits(credits: NormalizedCredits): string {
  if (!credits.hasCredits) return "no credits";
  if (credits.unlimited) return "unlimited";
  const balance = credits.balance?.trim();
  return balance ? `${formatNumber(Number(balance), balance)} credits` : "credits";
}

async function getJsonWithTimeout(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<unknown> {
  if (parentSignal?.aborted) return undefined;
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timeout = setTimeout(abort, timeoutMs);
  parentSignal?.addEventListener("abort", abort, { once: true });

  try {
    const response = await fetch(url, { method: "GET", headers, signal: controller.signal });
    if (!response.ok) return undefined;
    return await response.json();
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", abort);
  }
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

function buildCodexBackendHeaders(headers: Record<string, string>): Record<string, string> | undefined {
  const token = extractBearerToken(headers);
  if (!token) return undefined;

  const accountId = extractCodexAccountId(token);
  if (!accountId) return undefined;

  return {
    ...headers,
    Authorization: `Bearer ${token}`,
    "chatgpt-account-id": accountId,
    originator: "pi",
    "User-Agent": `pi (${os.platform()} ${os.release()}; ${os.arch()})`,
  };
}

function extractBearerToken(headers: Record<string, string>): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== "authorization") continue;
    const match = value.match(/^Bearer\s+(.+)$/i);
    return match?.[1]?.trim();
  }

  return undefined;
}

function extractCodexAccountId(token: string): string | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;

  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
    return asString(getRecord(getRecord(payload)?.[JWT_CLAIM_PATH])?.chatgpt_account_id);
  } catch {
    return undefined;
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

export function getSub2ApiUsageUrls(baseUrl: string): string[] {
  const urls = [`${baseUrl}/usage`];

  if (/\/v1$/i.test(baseUrl)) {
    urls.push(`${getProviderRootUrl(baseUrl)}/usage`);
  } else {
    urls.push(`${baseUrl}/v1/usage`);
  }

  return [...new Set(urls)];
}


export function extractRemaining(value: unknown): number | undefined {
  const record = getRecord(value);
  if (!record) return undefined;

  return (
    toNumber(record.remaining) ??
    toNumber(getRecord(record.data)?.remaining) ??
    toNumber(getRecord(record.usage)?.remaining)
  );
}

export function extractMoonshotAvailableBalance(value: unknown): number | undefined {
  const payload = getRecord(value);
  if (!payload) return undefined;
  if (toNumber(payload.code) !== 0 || payload.status !== true) return undefined;

  return toNumber(getRecord(payload.data)?.available_balance);
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

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function formatNumber(value: number, fallback: string): string {
  if (!Number.isFinite(value)) return fallback;
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
}

function redactErrorBody(body: string): string {
  return truncateEnd(
    body
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
      .replace(/"access_token"\s*:\s*"[^"]+"/gi, '"access_token":"<redacted>"')
      .trim(),
    MAX_ERROR_BODY_CHARS,
  );
}

function truncateEnd(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 1)}…`;
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
  if ("text" in result) return result.text;

  const amount = result.amount.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  return result.unit === "$" ? `${result.unit}${amount}` : `${amount}${result.unit}`;
}