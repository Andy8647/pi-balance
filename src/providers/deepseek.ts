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

// ══════════════════════════════════════════════════════════════
// DeepSeek balance provider
// ══════════════════════════════════════════════════════════════

export const deepseekProvider: BalanceProvider = {
  key: "deepseek",
  definition: {
    key: "deepseek",
    label: "DeepSeek",
    description: "DeepSeek /user/balance 余额",
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
      enabled: true, // will be determined by config
      details: [
        hasModel ? "已发现 DeepSeek 模型" : "未发现 DeepSeek 模型",
        configured ? "DeepSeek 认证可用" : "DeepSeek 认证不可用",
      ],
    };
  },
};

registry.register(deepseekProvider);
