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
    const provider = model.provider ?? "";
    const root = getProviderRootUrl(baseUrl);
    return (
      provider === "moonshot" ||
      provider === "kimi" ||
      provider.startsWith("kimi-") ||
      root.includes("moonshot.cn") ||
      root.includes("kimi.com")
    );
  },

  async fetchBalance(
    context: FetchContext,
    signal?: AbortSignal,
  ): Promise<BalanceResult | undefined> {
    const { baseUrl, headers } = context;
    const root = getProviderRootUrl(baseUrl);

    // Kimi Code (coding plan): show 5h ratelimit status instead of balance.
    if (root.includes("kimi.com")) {
      const statsText = await fetchKimiCodingStatus(root, headers, signal);
      if (statsText) return { text: statsText };
    }

    // Standard Moonshot API balance endpoint.
    const data = await getJson(`${root}/v1/users/me/balance`, headers, signal);
    const amount = extractMoonshotAvailableBalance(data);
    if (amount === undefined) return undefined;
    return { amount, unit: "¥" };
  },

  getSupport(ctx: ExtensionContext, _config: BalanceConfig): ProviderSupport {
    const models = ctx.modelRegistry.getAll();
    const availableModels = ctx.modelRegistry.getAvailable();

    const hasModel = models.some((model) =>
      model.provider === "moonshot" ||
      model.provider?.startsWith("kimi") ||
      model.baseUrl?.includes("moonshot.cn") ||
      model.baseUrl?.includes("kimi.com"),
    );
    const configured = availableModels.some((model) =>
      model.provider === "moonshot" ||
      model.provider?.startsWith("kimi") ||
      model.baseUrl?.includes("moonshot.cn") ||
      model.baseUrl?.includes("kimi.com"),
    );

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
}

function readKimiUsageDetail(d: unknown): KimiUsageDetail | undefined {
  if (!d || typeof d !== "object") return undefined;
  const detail = d as Record<string, unknown>;
  const limit = Number(detail.limit ?? detail.limit_amount ?? detail.total);
  const usedRaw = detail.used ?? detail.used_amount;
  const used = Number.isFinite(Number(usedRaw))
    ? Number(usedRaw)
    : Number.isFinite(limit) && Number.isFinite(Number(detail.remaining))
      ? limit - Number(detail.remaining)
      : NaN;
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return undefined;
  const resetRaw = detail.resetTime ?? detail.reset_at ?? detail.resetAt;
  const reset = typeof resetRaw === "string" ? Date.parse(resetRaw) : undefined;
  return { ratio: used / limit, reset };
}

function kimiWindowSeconds(w: unknown): number {
  if (!w || typeof w !== "object") return 0;
  const win = w as Record<string, unknown>;
  if (Number.isFinite(Number(win.seconds))) return Number(win.seconds);
  const unit = KIMI_WINDOW_UNIT_SECS[String(win.timeUnit ?? "")] ?? 0;
  return Number(win.duration ?? 0) * unit;
}

function extractKimiUsagesRatio(payload: unknown): KimiRatios | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const p = payload as Record<string, unknown>;
  const result: KimiRatios = {};

  // Weekly summary
  const weekly = readKimiUsageDetail(p.usage);
  if (weekly) {
    result.ratio7 = weekly.ratio;
    result.reset7 = weekly.reset;
  }

  // Per-window limits (5h, 7d, etc.)
  const items: unknown[] = [];
  if (Array.isArray(p.data)) items.push(...p.data);
  if (Array.isArray(p.limits)) items.push(...p.limits);

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const it = item as Record<string, unknown>;
    const d = (it.detail && typeof it.detail === "object" ? it.detail : it) as Record<string, unknown>;
    const windowSecs = kimiWindowSeconds(it.window ?? d.window ?? d.windowSeconds) ||
      Number(d.windowSeconds ?? 0);
    const is5h = windowSecs === 18000;
    const isWeek = windowSecs === 604800;
    const detail = readKimiUsageDetail(d);
    if (!detail) continue;

    if (is5h && result.ratio5 === undefined) {
      result.ratio5 = detail.ratio;
      result.reset5 = detail.reset;
    } else if (isWeek && result.ratio7 === undefined) {
      result.ratio7 = detail.ratio;
      result.reset7 = detail.reset;
    }
  }

  return (result.ratio5 !== undefined || result.ratio7 !== undefined) ? result : undefined;
}

function formatKimiCodingStatus(
  stats: { ratio5?: number; reset5?: number },
  now = Date.now(),
): string {
  const parts: string[] = [];
  if (stats.ratio5 !== undefined) {
    const pct = Math.round(stats.ratio5 * 100);
    let s = `5h·${pct}%`;
    if (stats.reset5 && stats.reset5 > now) {
      const ms = stats.reset5 - now;
      const h = Math.floor(ms / 3600000);
      const m = Math.ceil((ms % 3600000) / 60000);
      s += ` ↺${h > 0 ? `${h}h` : ""}${m}m`;
    }
    if (stats.ratio5 >= 1) s = ` ${s}`;
    parts.push(s);
  }
  return parts.length ? `Kimi: ${parts.join(" ")}` : "";
}

async function fetchJsonStatus(
  url: string,
  headers: Record<string, string>,
  parentSignal?: AbortSignal,
): Promise<{ status: number; data: unknown }> {
  if (parentSignal?.aborted) return { status: 0, data: undefined };
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timeout = setTimeout(abort, 10000);
  parentSignal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch(url, { method: "GET", headers, signal: controller.signal });
    if (!response.ok) return { status: response.status, data: undefined };
    return { status: response.status, data: await response.json() };
  } catch {
    return { status: -1, data: undefined };
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", abort);
  }
}

async function fetchKimiCodingStatus(
  root: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const candidates = [`${root}/v1/usages`, `${root}/usages`];
  for (const url of candidates) {
    const res = await fetchJsonStatus(
      url,
      { ...headers, "User-Agent": "KimiCLI/1.6" },
      signal,
    );
    if (!res.data) continue;
    const ratios = extractKimiUsagesRatio(res.data);
    if (ratios?.ratio5 !== undefined) {
      return formatKimiCodingStatus(ratios);
    }
  }
  return undefined;
}

registry.register(moonshotProvider);
