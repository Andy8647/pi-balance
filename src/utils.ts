import type { BalanceResult } from "./types.js";
import {
  MAX_ERROR_BODY_CHARS,
  REQUEST_TIMEOUT_MS,
} from "./types.js";

// ══════════════════════════════════════════════════════════════
// Pure data helpers
// ══════════════════════════════════════════════════════════════

export function getRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;

  if (typeof value === "string") {
    const parsed = Number(value.trim().replace(/%$/, ""));
    if (Number.isFinite(parsed)) return parsed;
  }

  return undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

export function formatNumber(value: number, fallback: string): string {
  if (!Number.isFinite(value)) return fallback;
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
}

export function truncateEnd(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 1)}…`;
}

export function hasHeader(headers: Record<string, string>, headerName: string): boolean {
  const normalizedHeaderName = headerName.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === normalizedHeaderName);
}

export function redactErrorBody(body: string): string {
  return truncateEnd(
    body
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
      .replace(/"access_token"\s*:\s*"[^"]+"/gi, '"access_token":"<redacted>"')
      .trim(),
    MAX_ERROR_BODY_CHARS,
  );
}

export function currencyToUnit(currency: string | undefined): string | undefined {
  switch (currency?.toUpperCase()) {
    case "CNY":
      return "¥";
    case "USD":
      return "$";
    default:
      return undefined;
  }
}

export function formatBalance(result: BalanceResult): string {
  if ("text" in result) return result.text;

  const amount = result.amount.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  return result.unit === "$" ? `${result.unit}${amount}` : `${amount}${result.unit}`;
}

// ══════════════════════════════════════════════════════════════
// URL helpers
// ══════════════════════════════════════════════════════════════

export function normalizeBaseUrl(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;

  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) return undefined;

  return trimmed.replace(/\/chat\/completions$/i, "").replace(/\/messages$/i, "");
}

export function getProviderRootUrl(baseUrl: string): string {
  return baseUrl.replace(/\/v1$/i, "");
}

// ══════════════════════════════════════════════════════════════
// Fetch helpers
// ══════════════════════════════════════════════════════════════

export async function getJson(
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

export async function getJsonWithTimeout(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<unknown> {
  if (parentSignal?.aborted) return undefined;
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timeout = setTimeout(abort, timeoutMs);
  parentSignal?.addEventListener("abort", abort, { once: true });

  try {
    const response = await fetch(url, { method: "GET", headers, signal: controller.signal });
    if (!response.ok) return undefined;
    return await response.json();
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", abort);
  }
}
