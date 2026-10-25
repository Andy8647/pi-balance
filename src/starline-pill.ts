import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { t } from "./i18n/index.js";

/**
 * Makes the balance pill clickable when pi-starline is installed.
 *
 * Starline already draws this extension's status as a footer pill. Through its
 * pill API (`globalThis[Symbol.for("pi-starline.pill-api.v1")]`) a click on that
 * pill opens a bubble with the balance, the change since the last check, when it
 * was fetched, and two actions. Without Starline the lookup finds nothing and
 * this module does nothing. Guide: pi-starline's docs/pill-api.md.
 */

// The slice of Starline's published types this module uses, copied rather than
// imported so pi-balance does not depend on pi-starline.
type PillAnchor = Record<string, unknown>;
type BubbleLine = string | { text: string; onSelect: () => void };
type BubbleContent = { title?: string; body: BubbleLine[]; hint?: string };
type BubbleHandle = { refresh(): void; isOpen(): boolean; onClose(callback: () => void): void };
type PillApi = {
  version: 1;
  register(
    key: string,
    action: (context: { ctx: ExtensionContext; pill?: PillAnchor; via?: "click" | "command" }) => void,
  ): () => void;
  showBubble(
    ctx: ExtensionContext,
    content: BubbleContent | (() => BubbleContent),
    pill?: PillAnchor,
  ): BubbleHandle | undefined;
};

export const PILL_API_SYMBOL = Symbol.for("pi-starline.pill-api.v1");

/** Starline's pill API, or undefined when Starline is not loaded. */
export function findPillApi(): PillApi | undefined {
  const api = (globalThis as Record<symbol, unknown>)[PILL_API_SYMBOL] as Partial<PillApi> | undefined;
  return api?.version === 1 && typeof api.register === "function" && typeof api.showBubble === "function"
    ? (api as PillApi)
    : undefined;
}

/** What the last fetch found, kept for the bubble. */
export type BalanceSnapshot = {
  /** Provider display name. */
  provider: string;
  /** The balance (`¥12.34`) or a provider's own summary (Codex usage). */
  text: string;
  /** Change since the previous check, already formatted (`▼ ¥0.05`). */
  delta?: string;
  /** Granted part of `text`, already formatted (`¥100.00`). */
  granted?: string;
  /** Paid-for part of `text`, already formatted (`¥1,346.14`). */
  toppedUp?: string;
  /** Epoch milliseconds of the fetch. */
  updatedAt: number;
};

export type BalancePillActions = {
  refresh: () => void;
  openMenu: (ctx: ExtensionContext) => void;
};

/** `12s`, `3m`, `2h`: how long ago, at a glance. */
export function formatAgo(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

export function balanceBubbleContent(
  snapshot: BalanceSnapshot | undefined,
  ctx: ExtensionContext,
  actions: BalancePillActions,
  now = Date.now(),
): BubbleContent {
  const split = [
    snapshot?.granted ? t("pill_granted", { amount: snapshot.granted }) : "",
    snapshot?.toppedUp ? t("pill_topped_up", { amount: snapshot.toppedUp }) : "",
  ].filter(Boolean);
  const body: BubbleLine[] = snapshot
    ? [
        snapshot.text,
        ...(split.length > 0 ? [split.join(" · ")] : []),
        ...(snapshot.delta ? [t("pill_since_last", { delta: snapshot.delta })] : []),
        t("pill_updated", { ago: formatAgo(now - snapshot.updatedAt) }),
      ]
    : [t("pill_no_balance")];
  body.push(
    { text: `↻ ${t("menu_refresh")}`, onSelect: actions.refresh },
    { text: `⚙ ${t("pill_open_menu")}`, onSelect: () => actions.openMenu(ctx) },
  );
  return {
    title: snapshot?.provider ?? t("pill_title"),
    body,
    hint: "↑↓ enter · click · esc",
  };
}

/** How often an open bubble re-reads the snapshot, so "updated … ago" moves. */
const LIVE_INTERVAL_MS = 1000;

/**
 * Register the click action for `statusKey` with Starline, if it is there.
 * Call from `session_start`; registering again replaces the earlier action.
 * Returns the unregister function, or undefined without Starline.
 */
export function registerBalancePill(
  statusKey: string,
  getSnapshot: () => BalanceSnapshot | undefined,
  actions: BalancePillActions,
): (() => void) | undefined {
  const api = findPillApi();
  if (!api) return undefined;
  return api.register(statusKey, ({ ctx, pill }) => {
    const handle = api.showBubble(
      ctx,
      () => balanceBubbleContent(getSnapshot(), ctx, actions),
      pill,
    );
    // Starline before live bubbles returns nothing; the static bubble is still fine.
    if (!handle) return;
    const timer = setInterval(() => handle.refresh(), LIVE_INTERVAL_MS);
    timer.unref?.();
    handle.onClose(() => clearInterval(timer));
  });
}
