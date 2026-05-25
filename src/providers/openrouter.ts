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

/** Compute OpenRouter remaining credits */
export function extractOpenRouterRemaining(value: unknown): number | undefined {
  const payload = getRecord(value);
  if (!payload) return undefined;
  const totalCredits = toNumber(getRecord(payload.data)?.total_credits);
  const totalUsage = toNumber(getRecord(payload.data)?.total_usage);
  if (totalCredits === undefined || totalUsage === undefined) return undefined;
  return totalCredits - totalUsage;
}

// ══════════════════════════════════════════════════════════════
// OpenRouter balance provider
// ══════════════════════════════════════════════════════════════

export const openrouterProvider: BalanceProvider = {
  key: "openrouter",
  definition: {
    key: "openrouter",
    label: "OpenRouter",
    description: t("desc_openrouter"),
    enabledByDefault: true,
  },

  shouldTry(model: Model<Api>, baseUrl: string): boolean {
    return model.provider === "openrouter" || baseUrl.includes("openrouter.ai");
  },

  async fetchBalance(
    context: FetchContext,
    signal?: AbortSignal,
  ): Promise<BalanceResult | undefined> {
    const { baseUrl, headers } = context;
    if (signal?.aborted) return undefined;

    const url = `${getProviderRootUrl(baseUrl)}/v1/credits`;
    const data = await getJson(url, headers, signal);
    const remaining = extractOpenRouterRemaining(data);
    if (remaining === undefined) return undefined;
    return { amount: remaining, unit: "$" };
  },

  getSupport(ctx: ExtensionContext, _config: BalanceConfig): ProviderSupport {
    const models = ctx.modelRegistry.getAll();
    const availableModels = ctx.modelRegistry.getAvailable();

    const hasModel = models.some((model) =>
      model.provider === "openrouter" || model.baseUrl?.includes("openrouter.ai"),
    );
    const configured = availableModels.some((model) =>
      model.provider === "openrouter" || model.baseUrl?.includes("openrouter.ai"),
    );

    return {
      provider: this.definition,
      configured,
      enabled: true,
      details: [
        hasModel ? t("support_model_found", { provider: "OpenRouter" }) : t("support_model_not_found", { provider: "OpenRouter" }),
        configured ? t("support_auth_available", { provider: "OpenRouter" }) : t("support_auth_unavailable", { provider: "OpenRouter" }),
      ],
    };
  },
};

registry.register(openrouterProvider);
