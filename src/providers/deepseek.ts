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

    // Aggregate each currency before selecting a balance; API order is unstable.
    const amounts = new Map<string, number>();

    for (const item of infos) {
      const record = getRecord(item);
      const amount = toNumber(record?.total_balance);
      const currency = typeof record?.currency === "string"
        ? record.currency.trim().toUpperCase()
        : undefined;
      if (amount === undefined || !currency) continue;

      amounts.set(currency, (amounts.get(currency) ?? 0) + amount);
    }

    // Prefer a funded currency (including debt) over an empty one. Currency
    // codes break ties consistently, including when every balance is zero.
    const balances = [...amounts]
      .filter(([, amount]) => Number.isFinite(amount))
      .sort(([a, amountA], [b, amountB]) => amountB - amountA || a.localeCompare(b));
    const best = balances.find(([, amount]) => amount !== 0) ?? balances[0];
    if (!best) return undefined;
    const [currency, amount] = best;

    // Convert only the selected USD balance, with a finite positive rate.
    if (currency === "USD") {
      const rate = Number(process.env.PI_BALANCE_CNY_RATE);
      const converted = amount * rate;
      if (Number.isFinite(rate) && rate > 0 && Number.isFinite(converted)) {
        return { amount: converted, unit: "¥" };
      }
    }

    return { amount, unit: currencyToUnit(currency) ?? currency };
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
