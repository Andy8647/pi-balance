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
// Moonshot balance provider
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
    return model.provider === "moonshot" || getProviderRootUrl(baseUrl).includes("moonshot.cn");
  },

  async fetchBalance(
    context: FetchContext,
    signal?: AbortSignal,
  ): Promise<BalanceResult | undefined> {
    const { baseUrl, headers } = context;
    const data = await getJson(
      `${getProviderRootUrl(baseUrl)}/v1/users/me/balance`,
      headers,
      signal,
    );
    const amount = extractMoonshotAvailableBalance(data);
    if (amount === undefined) return undefined;
    return { amount, unit: "¥" };
  },

  getSupport(ctx: ExtensionContext, _config: BalanceConfig): ProviderSupport {
    const models = ctx.modelRegistry.getAll();
    const availableModels = ctx.modelRegistry.getAvailable();

    const hasModel = models.some((model) =>
      model.provider === "moonshot" || model.baseUrl?.includes("moonshot.cn"),
    );
    const configured = availableModels.some((model) =>
      model.provider === "moonshot" || model.baseUrl?.includes("moonshot.cn"),
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

registry.register(moonshotProvider);
