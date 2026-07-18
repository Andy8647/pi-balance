import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  BalanceResult,
  BalanceConfig,
  FetchContext,
  ProviderSupport,
} from "../types.js";
import { getJson, getProviderRootUrl, getRecord, toNumber, currencyToUnit } from "../utils.js";
import type { BalanceProvider } from "./types.js";
import { registry } from "./registry.js";
import { t } from "../i18n/index.js";

// ══════════════════════════════════════════════════════════════
// DeepSeek balance provider
// ══════════════════════════════════════════════════════════════

export const deepseekProvider: BalanceProvider = {
  key: "deepseek",
  definition: {
    key: "deepseek",
    label: "DeepSeek",
    description: t("desc_deepseek"),
    enabledByDefault: true,
  },

  shouldTry(model: Model<Api>, baseUrl: string): boolean {
    return model.provider === "deepseek" || getProviderRootUrl(baseUrl).includes("deepseek.com");
  },

  async fetchBalance(
    context: FetchContext,
    signal?: AbortSignal,
  ): Promise<BalanceResult | undefined> {
    const { baseUrl, headers } = context;
    const data = await getJson(`${getProviderRootUrl(baseUrl)}/user/balance`, headers, signal);
    const infos = getRecord(data)?.balance_infos;

    if (!Array.isArray(infos)) return undefined;

    // DeepSeek returns one entry per currency (e.g. USD + CNY) with
    // unstable array order. Pick the currency that has the largest
    // total_balance, ignoring zero-balance entries.
    let bestCurrency: string | undefined;
    let bestAmount = -1;
    const amounts = new Map<string, number>();

    for (const item of infos) {
      const record = getRecord(item);
      const amount = toNumber(record?.total_balance);
      if (amount === undefined) continue;

      const currency = typeof record?.currency === "string" ? record.currency : undefined;
      const unit = currencyToUnit(currency) ?? currency;
      if (unit === undefined) continue;

      const prev = amounts.get(unit) ?? 0;
      const sum = prev + amount;
      amounts.set(unit, sum);

      if (sum > bestAmount) {
        bestAmount = sum;
        bestCurrency = unit;
      }
    }

    if (bestCurrency === undefined || bestAmount <= 0) return undefined;

    // Convert USD balances to CNY when PI_BALANCE_CNY_RATE is set.
    if (bestCurrency === "$") {
      const rate = Number(process.env.PI_BALANCE_CNY_RATE);
      if (rate > 0) {
        return { amount: bestAmount * rate, unit: "¥" };
      }
    }

    return { amount: bestAmount, unit: bestCurrency };
  },

  getSupport(
    ctx: ExtensionContext,
    _config: BalanceConfig,
  ): ProviderSupport {
    const models = ctx.modelRegistry.getAll();
    const availableModels = ctx.modelRegistry.getAvailable();

    const hasModel = models.some((model) =>
      model.provider === "deepseek" || model.baseUrl?.includes("deepseek.com"),
    );
    const configured = availableModels.some((model) =>
      model.provider === "deepseek" || model.baseUrl?.includes("deepseek.com"),
    );

    return {
      provider: this.definition,
      configured,
      enabled: true,
      details: [
        hasModel ? t("support_model_found", { provider: "DeepSeek" }) : t("support_model_not_found", { provider: "DeepSeek" }),
        configured ? t("support_auth_available", { provider: "DeepSeek" }) : t("support_auth_unavailable", { provider: "DeepSeek" }),
      ],
    };
  },
};

registry.register(deepseekProvider);
