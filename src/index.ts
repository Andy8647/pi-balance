import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type BalanceResult =
  | {
      kind?: "balance";
      amount: number;
      unit: string;
    }
  | {
      kind: "usage";
      entries: UsageEntry[];
    };

type UsageEntry = {
  usageType: string;
  percentage: number;
  resetsIn: string;
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

type ProviderKey = "deepseek" | "sub2api" | "opencode-go";

type ProviderDefinition = {
  key: ProviderKey;
  label: string;
  description: string;
  enabledByDefault: boolean;
};

type BalanceConfig = {
  disabledProviders: ProviderKey[];
  disabledSub2ApiProviders: string[];
  opencodeGoWorkspaceId?: string;
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
  {
    key: "opencode-go",
    label: "OpenCode Go",
    description: "OpenCode Go dashboard usage 限额",
    enabledByDefault: true,
  },
];
const PROVIDER_BY_KEY = new Map(PROVIDERS.map((provider) => [provider.key, provider]));

const BALANCE_FETCHERS: readonly BalanceFetcher[] = [
  tryOpenCodeGoUsage,
  tryDeepSeekBalance,
  trySub2ApiBalance,
];
const OPENCODE_GO_ORIGIN = "https://opencode.ai";
const OPENCODE_GO_USAGE_PATTERN =
  /(Rolling|Weekly|Monthly)\s+Usage\s*(\d+)%\s*Resets\s+in\s*(.*?)(?=\s*(?:Rolling|Weekly|Monthly)\s+Usage|$)/gis;
const OPENCODE_GO_WORKSPACE_ID_ENV_KEYS = [
  "OPENCODE_GO_WORKSPACE_ID",
  "OPENCODE_WORKSPACE_ID",
] as const;
const OPENCODE_GO_AUTH_ENV_KEYS = [
  "OPENCODE_GO_AUTH_COOKIE",
  "OPENCODE_GO_AUTH_TOKEN",
  "OPENCODE_AUTH_COOKIE",
  "OPENCODE_AUTH_TOKEN",
] as const;

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
        "opencode-go",
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

      if (action === "opencode-go") {
        await openOpenCodeGoMenu(pi, ctx, config, async (nextConfig) => {
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
  const opencodeGoWorkspaceId = typeof record?.opencodeGoWorkspaceId === "string"
    ? normalizeWorkspaceId(record.opencodeGoWorkspaceId)
    : undefined;

  return {
    disabledProviders: [...new Set(disabledProviders)],
    disabledSub2ApiProviders: [...new Set(disabledSub2ApiProviders)],
    ...(opencodeGoWorkspaceId ? { opencodeGoWorkspaceId } : {}),
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
    ["opencode-go", tryOpenCodeGoUsage],
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
  let openCodeGoExpanded = false;
  let sub2ApiExpanded = false;
  let deepSeekExpanded = false;

  while (true) {
    const supports = await getProviderSupports(ctx, config);
    const openCodeGoPrefix = openCodeGoExpanded ? "▼" : "▶";
    const sub2ApiPrefix = sub2ApiExpanded ? "▼" : "▶";
    const deepSeekPrefix = deepSeekExpanded ? "▼" : "▶";
    const openCodeGoWorkspaceId = getConfiguredOpenCodeWorkspaceId(config);
    const openCodeGoEnabled = isProviderEnabled(config, "opencode-go");
    const sub2ApiEnabled = isProviderEnabled(config, "sub2api");
    const deepSeekSupport = supports.find((support) => support.provider.key === "deepseek");
    const sub2ApiProviders = await getSub2ApiProviderCandidates(ctx);
    const options = [
      `${openCodeGoPrefix} OpenCode Go`,
      ...(openCodeGoExpanded
        ? [
            `  ${formatEnabled(openCodeGoEnabled)} Display`,
            `  Workspace ID: ${openCodeGoWorkspaceId ? maskValue(openCodeGoWorkspaceId) : "not set"}`,
          ]
        : []),
      `${sub2ApiPrefix} Sub2Api`,
      ...(sub2ApiExpanded
        ? [
            `  ${formatEnabled(sub2ApiEnabled)} Display`,
            ...sub2ApiProviders.map(
              (provider) => `  ${formatEnabled(isSub2ApiProviderEnabled(config, provider))} ${provider}`,
            ),
          ]
        : []),
      ...(deepSeekSupport
        ? [
            `${deepSeekPrefix} DeepSeek`,
            ...(deepSeekExpanded
              ? [
                  `  ${formatEnabled(deepSeekSupport.enabled)} Display`,
                ]
              : []),
          ]
        : []),
      "Back",
    ];
    const choice = await ctx.ui.select("pi-balance", options);
    if (!choice || choice === "Back") return;

    const trimmedChoice = choice.trimStart();

    if (choice === `${openCodeGoPrefix} OpenCode Go`) {
      openCodeGoExpanded = !openCodeGoExpanded;
      continue;
    }

    if (choice === `${sub2ApiPrefix} Sub2Api`) {
      sub2ApiExpanded = !sub2ApiExpanded;
      continue;
    }

    if (choice === `${deepSeekPrefix} DeepSeek`) {
      deepSeekExpanded = !deepSeekExpanded;
      continue;
    }

    if (openCodeGoExpanded && trimmedChoice.includes("Display")) {
      const nextConfig = setProviderEnabled(config, "opencode-go", !openCodeGoEnabled);
      await onConfigChange(nextConfig);
      config = nextConfig;
      continue;
    }

    if (openCodeGoExpanded && trimmedChoice.startsWith("Workspace ID")) {
      const nextWorkspaceId = await ctx.ui.input(
        "OpenCode Go Workspace ID",
        openCodeGoWorkspaceId ?? "从 https://opencode.ai/workspace/{id}/go 复制 id",
      );
      if (nextWorkspaceId === undefined) continue;

      const normalized = normalizeWorkspaceId(nextWorkspaceId);
      const nextConfig: BalanceConfig = {
        ...config,
        ...(normalized ? { opencodeGoWorkspaceId: normalized } : { opencodeGoWorkspaceId: undefined }),
      };
      await onConfigChange(nextConfig);
      config = nextConfig;
      ctx.ui.notify(normalized ? "Workspace ID saved" : "Workspace ID cleared", "info");
      continue;
    }

    if (sub2ApiExpanded && trimmedChoice.includes("Display")) {
      const nextConfig = setProviderEnabled(config, "sub2api", !sub2ApiEnabled);
      await onConfigChange(nextConfig);
      config = nextConfig;
      continue;
    }

    if (sub2ApiExpanded) {
      const provider = sub2ApiProviders.find((candidate) => trimmedChoice.endsWith(candidate));
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
    }

    if (deepSeekExpanded && deepSeekSupport && trimmedChoice.includes("Display")) {
      const nextConfig = setProviderEnabled(config, "deepseek", !deepSeekSupport.enabled);
      await onConfigChange(nextConfig);
      config = nextConfig;
      continue;
    }
  }
}


async function openOpenCodeGoMenu(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: BalanceConfig,
  onConfigChange: (config: BalanceConfig) => Promise<void>,
): Promise<void> {
  while (true) {
    const workspaceId = getConfiguredOpenCodeWorkspaceId(config);
    const enabled = isProviderEnabled(config, "opencode-go");
    const options = [
      `${formatEnabled(enabled)} Display`,
      `Workspace ID: ${workspaceId ? maskValue(workspaceId) : "not set"}`,
      "Back",
    ];
    const choice = await ctx.ui.select("pi-balance / OpenCode Go", options);
    if (!choice || choice === "Back") return;

    if (choice.includes("Display")) {
      const nextConfig = setProviderEnabled(config, "opencode-go", !enabled);
      await onConfigChange(nextConfig);
      config = nextConfig;
      continue;
    }

    if (choice.startsWith("Workspace ID")) {
      const nextWorkspaceId = await ctx.ui.input(
        "OpenCode Go Workspace ID",
        workspaceId ?? "从 https://opencode.ai/workspace/{id}/go 复制 id",
      );
      if (nextWorkspaceId === undefined) continue;

      const normalized = normalizeWorkspaceId(nextWorkspaceId);
      const nextConfig: BalanceConfig = {
        ...config,
        ...(normalized ? { opencodeGoWorkspaceId: normalized } : { opencodeGoWorkspaceId: undefined }),
      };
      await onConfigChange(nextConfig);
      config = nextConfig;
      ctx.ui.notify(normalized ? "Workspace ID saved" : "Workspace ID cleared", "info");
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
    const options = [
      `${formatEnabled(isProviderEnabled(config, "sub2api"))} Display`,
      ...providers.map(
        (provider) => `${formatEnabled(isSub2ApiProviderEnabled(config, provider))} ${provider}`,
      ),
      "Back",
    ];
    const choice = await ctx.ui.select("pi-balance / Sub2Api", options);
    if (!choice || choice === "Back") return;

    if (choice.includes("Display")) {
      const nextConfig = setProviderEnabled(config, "sub2api", !isProviderEnabled(config, "sub2api"));
      await onConfigChange(nextConfig);
      config = nextConfig;
      continue;
    }


    const provider = providers.find((candidate) => choice.endsWith(candidate));
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

function getOpenCodeGoBadge(config: BalanceConfig): string {
  const enabled = isProviderEnabled(config, "opencode-go") ? "on" : "off";
  const workspace = getConfiguredOpenCodeWorkspaceId(config) ? "workspace set" : "workspace not set";
  return `${enabled}, ${workspace}`;
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

function maskValue(value: string): string {
  if (value.length <= 8) return value;
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
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

    if (provider.key === "opencode-go") {
      const hasOpenCodeGoModel = modelProviders.has("opencode-go") ||
        models.some((model) => isOpenCodeGoBaseUrl(normalizeBaseUrl(model.baseUrl) ?? ""));
      const hasWorkspace = Boolean(getFirstEnv(OPENCODE_GO_WORKSPACE_ID_ENV_KEYS));
      const hasAuth = Boolean(getFirstEnv(OPENCODE_GO_AUTH_ENV_KEYS)) || availableProviders.has("opencode-go");
      configured = hasOpenCodeGoModel && hasWorkspace && hasAuth;
      details.push(hasOpenCodeGoModel ? "已发现 OpenCode Go 模型" : "未发现 OpenCode Go 模型");
      details.push(hasWorkspace ? "已配置 workspace ID" : "缺少 OPENCODE_GO_WORKSPACE_ID");
      details.push(hasAuth ? "已配置 auth" : "缺少 OPENCODE_GO_AUTH_COOKIE / TOKEN");
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

async function tryOpenCodeGoUsage(
  context: FetchContext,
  signal?: AbortSignal,
): Promise<BalanceResult | undefined> {
  const { baseUrl, headers, model } = context;
  if (!isOpenCodeGoModel(model, baseUrl)) return undefined;

  const workspaceId = getOpenCodeWorkspaceId(baseUrl) ?? getOpenCodeWorkspaceIdFromConfig(context.config, headers);
  if (!workspaceId) return undefined;

  const requestHeaders = buildOpenCodeHeaders(headers);
  const html = await getText(
    `${OPENCODE_GO_ORIGIN}/workspace/${encodeURIComponent(workspaceId)}/go`,
    requestHeaders,
    signal,
  );
  const entries = extractOpenCodeGoUsage(html);

  return entries.length > 0 ? { kind: "usage", entries } : undefined;
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

async function getText(
  url: string,
  headers: Record<string, string>,
  parentSignal?: AbortSignal,
): Promise<string | undefined> {
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

    return await response.text();
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

function isOpenCodeGoModel(model: Model<Api>, baseUrl: string): boolean {
  return model.provider === "opencode-go" || isOpenCodeGoBaseUrl(baseUrl);
}

function isOpenCodeGoBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    const host = url.hostname.toLowerCase();
    const path = url.pathname.toLowerCase();

    return (host === "opencode.ai" || host.endsWith(".opencode.ai")) && path.includes("/go");
  } catch {
    return /(^|\.)opencode\.ai(?::|\/|$)/i.test(baseUrl) && /\/go(?:\/|$)/i.test(baseUrl);
  }
}

function getOpenCodeWorkspaceId(baseUrl: string): string | undefined {
  try {
    const url = new URL(baseUrl);
    const workspaceIndex = url.pathname.split("/").filter(Boolean).indexOf("workspace");
    const workspaceId = workspaceIndex >= 0
      ? url.pathname.split("/").filter(Boolean)[workspaceIndex + 1]
      : undefined;

    return normalizeWorkspaceId(workspaceId);
  } catch {
    const match = baseUrl.match(/\/workspace\/([^/?#]+)/i);
    return normalizeWorkspaceId(match?.[1]);
  }
}

function getOpenCodeWorkspaceIdFromConfig(
  config: BalanceConfig,
  headers: Record<string, string>,
): string | undefined {
  return normalizeWorkspaceId(
    getHeader(headers, "x-opencode-workspace-id") ??
      getHeader(headers, "x-workspace-id") ??
      getHeader(headers, "opencode-workspace-id") ??
      config.opencodeGoWorkspaceId ??
      getFirstEnv(OPENCODE_GO_WORKSPACE_ID_ENV_KEYS),
  );
}

function normalizeWorkspaceId(value: string | undefined): string | undefined {
  if (!value) return undefined;

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function getConfiguredOpenCodeWorkspaceId(config: BalanceConfig): string | undefined {
  return normalizeWorkspaceId(config.opencodeGoWorkspaceId) ?? getFirstEnv(OPENCODE_GO_WORKSPACE_ID_ENV_KEYS);
}

function buildOpenCodeHeaders(headers: Record<string, string>): Record<string, string> {
  const authToken = getOpenCodeAuthToken(headers);
  const cookie = mergeCookieAuth(getHeader(headers, "cookie"), authToken);
  const requestHeaders: Record<string, string> = {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    ...headers,
  };

  if (cookie) requestHeaders.Cookie = cookie;

  deleteHeader(requestHeaders, "authorization");
  deleteHeader(requestHeaders, "x-opencode-workspace-id");
  deleteHeader(requestHeaders, "x-workspace-id");
  deleteHeader(requestHeaders, "opencode-workspace-id");

  return requestHeaders;
}

function getOpenCodeAuthToken(headers: Record<string, string>): string | undefined {
  const explicitToken =
    getHeader(headers, "x-opencode-auth") ??
    getHeader(headers, "x-opencode-auth-token") ??
    getHeader(headers, "opencode-auth") ??
    getFirstEnv(OPENCODE_GO_AUTH_ENV_KEYS);
  if (explicitToken) return trimAuthCookie(explicitToken);

  const authorization = getHeader(headers, "authorization");
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();

  return bearer || authorization?.trim();
}

function mergeCookieAuth(cookie: string | undefined, authToken: string | undefined): string | undefined {
  const tokenCookieParts = authToken
    ?.split(";")
    .map((part) => part.trim())
    .filter(Boolean) ?? [];
  const explicitAuthCookie = tokenCookieParts.find((part) => /^auth=/i.test(part));
  const localeCookie = tokenCookieParts.find((part) => /^oc_locale=/i.test(part));
  const authValue = explicitAuthCookie?.replace(/^auth=/i, "") ?? authToken;
  const parts = cookie
    ?.split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !/^oc_locale=/i.test(part) && !/^auth=/i.test(part)) ?? [];

  if (authValue) parts.push(`auth=${authValue}`);
  parts.push(localeCookie ?? "oc_locale=en");

  return parts.length > 0 ? parts.join("; ") : undefined;
}

function trimAuthCookie(value: string): string {
  return value.trim().replace(/^auth=/i, "");
}

function getFirstEnv(keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }

  return undefined;
}

function extractOpenCodeGoUsage(html: string | undefined): UsageEntry[] {
  if (!html) return [];

  const text = decodeHtmlEntities(stripHtml(html)).replace(/\s+/g, " ").trim();
  const entries: UsageEntry[] = [];

  for (const match of text.matchAll(OPENCODE_GO_USAGE_PATTERN)) {
    const percentage = toNumber(match[2]);
    if (percentage === undefined) continue;

    entries.push({
      usageType: match[1],
      percentage,
      resetsIn: match[3].trim(),
    });
  }

  return entries;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_match, codePoint: string) =>
      String.fromCodePoint(Number(codePoint)),
    )
    .replace(/&#x([\da-f]+);/gi, (_match, codePoint: string) =>
      String.fromCodePoint(Number.parseInt(codePoint, 16)),
    );
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

function getHeader(headers: Record<string, string>, headerName: string): string | undefined {
  const normalizedHeaderName = headerName.toLowerCase();
  const matchedKey = Object.keys(headers).find((key) => key.toLowerCase() === normalizedHeaderName);

  return matchedKey ? headers[matchedKey] : undefined;
}

function deleteHeader(headers: Record<string, string>, headerName: string): void {
  const normalizedHeaderName = headerName.toLowerCase();

  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === normalizedHeaderName) delete headers[key];
  }
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
  if (result.kind === "usage") return formatUsage(result.entries);

  const amount = result.amount.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  return result.unit === "$" ? `${result.unit}${amount}` : `${amount}${result.unit}`;
}

function formatUsage(entries: UsageEntry[]): string {
  return entries
    .map((entry) => `${entry.usageType} ${entry.percentage}%${formatResetsIn(entry.resetsIn)}`)
    .join(" · ");
}

function formatResetsIn(resetsIn: string): string {
  return resetsIn ? ` (${resetsIn})` : "";
}
