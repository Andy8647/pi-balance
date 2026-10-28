import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  BalanceResult,
  BalanceConfig,
  FetchContext,
  ProviderSupport,
} from "../types.js";
import { getJson, getProviderRootUrl, getRecord, toNumber } from "../utils.js";
import type { BalanceProvider } from "./types.js";
import { registry } from "./registry.js";
import { t } from "../i18n/index.js";

/** Extract Moonshot available balance */
export function extractMoonshotAvailableBalance(value: unknown): number | undefined {
  const payload = getRecord(value);
  if (!payload) return undefined;
  if (toNumber(payload.code) !== 0 || payload.status !== true) return undefined;
  return toNumber(getRecord(payload.data)?.available_balance);
}

function hasProviderHost(baseUrl: string, domain: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname;
    return hostname === domain || hostname.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

function isKimiCoding(model: Model<Api>, baseUrl: string): boolean {
  const provider = model.provider ?? "";
  return provider === "kimi" || provider.startsWith("kimi-") || hasProviderHost(baseUrl, "kimi.com");
}

// ══════════════════════════════════════════════════════════════
// Moonshot / Kimi balance provider
// ══════════════════════════════════════════════════════════════

export const moonshotProvider: BalanceProvider = {
  key: "moonshot",
  definition: {
    key: "moonshot",
    label: "Moonshot",
    description: t("desc_moonshot"),
    enabledByDefault: true,
  },

  shouldTry(model: Model<Api>, baseUrl: string): boolean {
    return model.provider === "moonshot" || isKimiCoding(model, baseUrl) ||
      hasProviderHost(baseUrl, "moonshot.cn") || hasProviderHost(baseUrl, "moonshot.ai");
  },

  async fetchBalance(
    context: FetchContext,
    signal?: AbortSignal,
  ): Promise<BalanceResult | undefined> {
    const { model, baseUrl, headers } = context;
    const root = getProviderRootUrl(baseUrl);

    if (isKimiCoding(model, baseUrl)) {
      const statsText = await fetchKimiCodingStatus(root, headers, signal);
      if (statsText) return { text: statsText };
    }

    // Standard Moonshot API balance endpoint, also used as a Kimi fallback.
    const data = await getJson(`${root}/v1/users/me/balance`, headers, signal);
    const amount = extractMoonshotAvailableBalance(data);
    if (amount === undefined) return undefined;
    return { amount, unit: "¥" };
  },

  getSupport(ctx: ExtensionContext, _config: BalanceConfig): ProviderSupport {
    const matches = (model: Model<Api>) => this.shouldTry(model, model.baseUrl ?? "");
    const hasModel = ctx.modelRegistry.getAll().some(matches);
    const configured = ctx.modelRegistry.getAvailable().some(matches);

    return {
      provider: this.definition,
      configured,
      enabled: true,
      details: [
        hasModel ? t("support_model_found", { provider: "Moonshot" }) : t("support_model_not_found", { provider: "Moonshot" }),
        configured ? t("support_auth_available", { provider: "Moonshot" }) : t("support_auth_unavailable", { provider: "Moonshot" }),
      ],
    };
  },
};

// ══════════════════════════════════════════════════════════════
// Kimi Code (coding plan) usage status
// ══════════════════════════════════════════════════════════════

const KIMI_WINDOW_UNIT_SECS: Record<string, number> = {
  TIME_UNIT_SECOND: 1,
  TIME_UNIT_MINUTE: 60,
  TIME_UNIT_HOUR: 3600,
  TIME_UNIT_DAY: 86400,
};

interface KimiUsageDetail {
  ratio: number;
  reset?: number;
}

interface KimiRatios {
  ratio5?: number;
  reset5?: number;
  ratio7?: number;
  reset7?: number;
  boosterLeft?: number;
}

function kimiNumber(value: unknown): number | undefined {
  if (typeof value === "string" && !value.trim()) return undefined;
  return toNumber(value);
}

function kimiResetTime(value: unknown): number | undefined {
  const timestamp = kimiNumber(value);
  const reset = timestamp !== undefined
    ? timestamp < 1e12 ? timestamp * 1000 : timestamp
    : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(reset) ? reset : undefined;
}

function readKimiUsageDetail(value: unknown): KimiUsageDetail | undefined {
  const detail = getRecord(value);
  if (!detail) return undefined;
  const limit = kimiNumber(detail.limit ?? detail.limit_amount ?? detail.total);
  if (limit === undefined || limit <= 0) return undefined;

  const remaining = kimiNumber(detail.remaining);
  const used = kimiNumber(detail.used ?? detail.used_amount) ??
    (remaining !== undefined ? limit - remaining : undefined);
  if (used === undefined) return undefined;

  return {
    ratio: Math.min(1, Math.max(0, used / limit)),
    reset: kimiResetTime(detail.resetTime ?? detail.reset_at ?? detail.resetAt),
  };
}

function kimiWindowSeconds(value: unknown): number | undefined {
  const window = getRecord(value);
  if (!window) return undefined;
  const seconds = kimiNumber(window.seconds);
  if (seconds !== undefined) return seconds;
  const duration = kimiNumber(window.duration);
  const unit = KIMI_WINDOW_UNIT_SECS[String(window.timeUnit ?? "")];
  return duration !== undefined && unit !== undefined ? duration * unit : undefined;
}

function extractKimiUsagesRatio(payload: unknown): KimiRatios | undefined {
  const root = getRecord(payload);
  if (!root) return undefined;
  const data = getRecord(root.data) ?? root;
  const result: KimiRatios = {};

  const weekly = readKimiUsageDetail(data.usage);
  if (weekly) {
    result.ratio7 = weekly.ratio;
    result.reset7 = weekly.reset;
  }

  const items: unknown[] = [];
  if (Array.isArray(data.data)) items.push(...data.data);
  if (Array.isArray(data.limits)) items.push(...data.limits);

  for (const item of items) {
    const record = getRecord(item);
    if (!record) continue;
    const detail = getRecord(record.detail) ?? record;
    const windowSeconds = kimiWindowSeconds(record.window ?? detail.window) ??
      kimiNumber(record.windowSeconds ?? detail.windowSeconds);
    const usage = readKimiUsageDetail(detail);
    if (!usage) continue;

    if (windowSeconds === 18000 && result.ratio5 === undefined) {
      result.ratio5 = usage.ratio;
      result.reset5 = usage.reset;
    } else if (windowSeconds === 604800 && result.ratio7 === undefined) {
      result.ratio7 = usage.ratio;
      result.reset7 = usage.reset;
    }
  }

  const wallet = getRecord(data.boosterWallet);
  if (wallet?.status === "STATUS_ENABLED") {
    const left = kimiNumber(getRecord(wallet.balance)?.amountLeft);
    if (left !== undefined) result.boosterLeft = left / 1e8;
  }

  return result.ratio5 !== undefined || result.ratio7 !== undefined ? result : undefined;
}

function formatKimiWindow(
  name: "5h" | "7d",
  ratio: number | undefined,
  reset: number | undefined,
  now: number,
): string | undefined {
  if (ratio === undefined) return undefined;
  let text = `${name}·${Math.round((1 - ratio) * 100)}%`;
  if (reset === undefined || reset <= now) return text;

  if (name === "5h") {
    const minutes = Math.ceil((reset - now) / 60000);
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    text += `↺${hours > 0 ? `${hours}h` : ""}${rest > 0 ? `${rest}m` : ""}`;
  } else {
    const hours = Math.ceil((reset - now) / 3600000);
    const days = Math.floor(hours / 24);
    const rest = hours % 24;
    text += `↺${days > 0 ? `${days}d` : ""}${rest > 0 ? `${rest}h` : ""}`;
  }
  return text;
}

function formatKimiCodingStatus(stats: KimiRatios, now = Date.now()): string {
  const parts = [
    formatKimiWindow("5h", stats.ratio5, stats.reset5, now),
    formatKimiWindow("7d", stats.ratio7, stats.reset7, now),
  ].filter((part): part is string => part !== undefined);
  if (stats.boosterLeft !== undefined) parts.push(`¥${stats.boosterLeft.toFixed(2)}`);
  return `Kimi: ${parts.join(" ")}`;
}

async function fetchKimiCodingStatus(
  root: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const candidates = [`${root}/v1/usages`, `${root}/usages`];
  for (const url of candidates) {
    if (signal?.aborted) return undefined;
    const data = await getJson(url, { ...headers, "User-Agent": "KimiCLI/1.6" }, signal);
    const ratios = extractKimiUsagesRatio(data);
    if (ratios) return formatKimiCodingStatus(ratios);
  }
  return undefined;
}

registry.register(moonshotProvider);
