import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  BalanceResult,
  BalanceConfig,
  FetchContext,
  ProviderSupport,
  CodexUsageReport,
  NormalizedRateLimitSnapshot,
  NormalizedRateLimitWindow,
  NormalizedCredits,
  PendingRpc,
  RpcResponse,
} from "../types.js";
import {
  CODEX_PROVIDER_ID,
  CODEX_USAGE_URL,
  CODEX_APP_SERVER_TIMEOUT_MS,
  CODEX_STATUS_PREFIX,
  MAX_ERROR_BODY_CHARS,
  JWT_CLAIM_PATH,
} from "../types.js";
import {
  getJsonWithTimeout,
  getRecord,
  toNumber,
  asString,
  asBoolean,
  clampPercent,
  formatNumber,
  truncateEnd,
  hasHeader,
  redactErrorBody,
} from "../utils.js";
import * as os from "node:os";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { BalanceProvider, ExtraMenuAction } from "./types.js";
import { registry } from "./registry.js";
import { t } from "../i18n/index.js";

// ══════════════════════════════════════════════════════════════
// Codex: balance fetching
// ══════════════════════════════════════════════════════════════

async function queryCodexUsageViaPiAuth(
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<CodexUsageReport | undefined> {
  if (!hasHeader(headers, "authorization")) return undefined;

  const codexHeaders = buildCodexBackendHeaders(headers);
  if (!codexHeaders) return undefined;

  const data = await getJsonWithTimeout(
    CODEX_USAGE_URL,
    codexHeaders,
    CODEX_APP_SERVER_TIMEOUT_MS,
    signal,
  );
  const payload = getRecord(data);
  if (!payload) return undefined;

  return normalizeBackendPayload(payload, Date.now(), "pi-auth");
}

async function queryCodexUsageViaAppServer(
  signal?: AbortSignal,
): Promise<CodexUsageReport | undefined> {
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

// ══════════════════════════════════════════════════════════════
// Codex: auth header construction
// ══════════════════════════════════════════════════════════════

function buildCodexBackendHeaders(
  headers: Record<string, string>,
): Record<string, string> | undefined {
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

// ══════════════════════════════════════════════════════════════
// Codex: backend payload normalization
// ══════════════════════════════════════════════════════════════

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

// ══════════════════════════════════════════════════════════════
// Codex: app-server response normalization
// ══════════════════════════════════════════════════════════════

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

function normalizeCredits(
  value: unknown,
  source: "backend" | "app-server",
): NormalizedCredits | undefined {
  const credits = getRecord(value);
  if (!credits) return undefined;
  const hasCredits = asBoolean(source === "backend" ? credits.has_credits : credits.hasCredits);
  const unlimited = asBoolean(credits.unlimited);
  if (hasCredits === undefined || unlimited === undefined) return undefined;
  return { hasCredits, unlimited, balance: asString(credits.balance) };
}

// ══════════════════════════════════════════════════════════════
// Codex: statusline formatting
// ══════════════════════════════════════════════════════════════

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
  const exact = report.snapshots.find(
    (snapshot) =>
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
  if (!credits.hasCredits) return t("codex_no_credits");
  if (credits.unlimited) return t("codex_unlimited");
  const balance = credits.balance?.trim();
  return balance ? `${formatNumber(Number(balance), balance)} ${t("codex_credits")}` : t("codex_credits");
}

// ══════════════════════════════════════════════════════════════
// Codex app-server RPC client
// ══════════════════════════════════════════════════════════════

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
        this.dispose();
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

// ══════════════════════════════════════════════════════════════
// Codex: the BalanceProvider
// ══════════════════════════════════════════════════════════════

export const codexProvider: BalanceProvider = {
  key: "codex",
  definition: {
    key: "codex",
    label: "OpenAI Codex",
    description: t("desc_codex"),
    enabledByDefault: true,
  },

  shouldTry(model: Model<Api>): boolean {
    return model.provider === CODEX_PROVIDER_ID;
  },

  async fetchBalance(
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
  },

  getSupport(ctx: ExtensionContext, config: BalanceConfig): ProviderSupport {
    const models = ctx.modelRegistry.getAll();
    const availableProviders = new Set(
      ctx.modelRegistry.getAvailable().map((model) => model.provider),
    );

    const hasCodexModel = models.some((model) => model.provider === CODEX_PROVIDER_ID);
    const configured = availableProviders.has(CODEX_PROVIDER_ID);

    return {
      provider: this.definition,
      configured,
      enabled: true,
      details: [
        hasCodexModel ? t("support_model_found", { provider: "OpenAI Codex" }) : t("support_model_not_found", { provider: "OpenAI Codex" }),
        configured ? t("support_auth_available", { provider: "OpenAI Codex" }) : t("support_auth_unavailable", { provider: "OpenAI Codex" }),
        config.codexAppServerFallback
          ? t("support_codex_fallback_on")
          : t("support_codex_fallback_off"),
      ],
    };
  },

  getExtraMenuActions(config: BalanceConfig): ExtraMenuAction[] {
    return [
      {
        id: "codex-cli-fallback",
        getLabel(cfg: BalanceConfig): string {
          const icon = cfg.codexAppServerFallback ? "◉" : "○";
          return `  ${icon} ${t("codex_cli_fallback")} - OpenAI Codex`;
        },
        onToggle(cfg: BalanceConfig): BalanceConfig {
          return { ...cfg, codexAppServerFallback: !cfg.codexAppServerFallback };
        },
      },
    ];
  },
};

registry.register(codexProvider);
