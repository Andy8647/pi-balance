import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";

type BalanceResult = {
  amount: number;
  unit: string;
};

type BalanceFetcher = (
  baseUrl: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
) => Promise<BalanceResult | undefined>;

const STATUS_KEY = "provider-balance";
const REQUEST_TIMEOUT_MS = 8000;
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

const BALANCE_FETCHERS: readonly BalanceFetcher[] = [
  tryDeepSeekBalance,
  trySub2ApiBalance,
];

export default function (pi: ExtensionAPI) {
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let activeRequest: AbortController | undefined;
  let requestVersion = 0;

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
      const result = await fetchProviderBalance(ctx, model, controller.signal);

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

  pi.on("session_start", async (_event, ctx) => {
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

async function fetchProviderBalance(
  ctx: ExtensionContext,
  model: Model<Api>,
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

  for (const fetcher of BALANCE_FETCHERS) {
    if (signal?.aborted) return undefined;

    const result = await fetcher(baseUrl, headers, signal);
    if (result) return result;
  }

  return undefined;
}

async function tryDeepSeekBalance(
  baseUrl: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<BalanceResult | undefined> {
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
  baseUrl: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<BalanceResult | undefined> {
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
    const parsed = Number(value.trim());
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
