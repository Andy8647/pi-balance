import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { setLanguage } from "../src/i18n/index.ts";
import {
  balanceBubbleContent,
  findPillApi,
  formatAgo,
  PILL_API_SYMBOL,
  registerBalancePill,
  type BalanceSnapshot,
} from "../src/starline-pill.ts";

setLanguage("en");

const host = globalThis as Record<symbol, unknown>;
const ctx = {} as never;

afterEach(() => {
  delete host[PILL_API_SYMBOL];
});

type Line = string | { text: string; onSelect: () => void };

/** A stand-in for pi-starline's published API that records what it was given. */
function fakeStarline() {
  const registered = new Map<string, (context: { ctx: unknown; pill?: unknown }) => void>();
  const bubbles: Array<{ content: () => { title?: string; body: Line[] }; pill: unknown; closers: Array<() => void> }> = [];
  host[PILL_API_SYMBOL] = {
    version: 1,
    register(key: string, action: (context: { ctx: unknown; pill?: unknown }) => void) {
      registered.set(key, action);
      return () => registered.delete(key);
    },
    showBubble(_ctx: unknown, content: () => { title?: string; body: Line[] }, pill: unknown) {
      const closers: Array<() => void> = [];
      bubbles.push({ content, pill, closers });
      return {
        refresh() {},
        isOpen: () => true,
        onClose(callback: () => void) {
          closers.push(callback);
        },
      };
    },
  };
  return { registered, bubbles };
}

const snapshot: BalanceSnapshot = {
  provider: "DeepSeek",
  text: "¥12.34",
  delta: "▼ ¥0.05",
  updatedAt: 1_000,
};

test("does nothing without pi-starline", () => {
  assert.equal(findPillApi(), undefined);
  assert.equal(registerBalancePill("provider-balance", () => snapshot, { refresh() {}, openMenu() {} }), undefined);
});

test("ignores an object that is not the v1 pill API", () => {
  host[PILL_API_SYMBOL] = { version: 2, register() {}, showBubble() {} };
  assert.equal(findPillApi(), undefined);
});

test("registers the status key and opens a live bubble on the pill", () => {
  const { registered, bubbles } = fakeStarline();
  const unregister = registerBalancePill("provider-balance", () => snapshot, { refresh() {}, openMenu() {} });
  assert.ok(unregister);
  const action = registered.get("provider-balance");
  assert.ok(action);

  const pill = { key: "provider-balance" };
  action({ ctx, pill });
  assert.equal(bubbles.length, 1);
  assert.equal(bubbles[0]?.pill, pill);
  assert.equal(typeof bubbles[0]?.content, "function");
  // The once-a-second timer stops when the bubble closes.
  assert.equal(bubbles[0]?.closers.length, 1);
  bubbles[0]?.closers[0]?.();

  unregister();
  assert.equal(registered.has("provider-balance"), false);
});

test("the bubble shows the balance, the change, the age, and two actions", () => {
  let refreshed = 0;
  let menus = 0;
  const content = balanceBubbleContent(
    snapshot,
    ctx,
    { refresh: () => refreshed++, openMenu: () => menus++ },
    1_000 + 42_000,
  );
  assert.equal(content.title, "DeepSeek");
  assert.deepEqual(content.body.slice(0, 3), ["¥12.34", "Since last check: ▼ ¥0.05", "Updated 42s ago"]);

  const [refresh, menu] = content.body.slice(3) as Array<{ text: string; onSelect: () => void }>;
  assert.equal(refresh?.text, "↻ Refresh");
  assert.equal(menu?.text, "⚙ Open /balance");
  refresh?.onSelect();
  menu?.onSelect();
  assert.equal(refreshed, 1);
  assert.equal(menus, 1);
});

test("the bubble splits the balance into granted and paid-for", () => {
  const content = balanceBubbleContent(
    { ...snapshot, granted: "¥2.00", toppedUp: "¥10.34" },
    ctx,
    { refresh() {}, openMenu() {} },
    1_000,
  );
  assert.deepEqual(content.body.slice(0, 4), [
    "¥12.34",
    "Granted ¥2.00 · Top-up ¥10.34",
    "Since last check: ▼ ¥0.05",
    "Updated 0s ago",
  ]);
});

test("without a split the bubble keeps one line per fact", () => {
  const content = balanceBubbleContent(snapshot, ctx, { refresh() {}, openMenu() {} }, 1_000);
  assert.deepEqual(content.body.slice(0, 3), ["¥12.34", "Since last check: ▼ ¥0.05", "Updated 0s ago"]);
});

test("without a balance it says so and still offers the actions", () => {
  const content = balanceBubbleContent(undefined, ctx, { refresh() {}, openMenu() {} });
  assert.equal(content.title, "Balance");
  assert.equal(content.body[0], "No balance for the current model");
  assert.equal(content.body.length, 3);
});

test("formatAgo reads at a glance", () => {
  assert.equal(formatAgo(-1), "0s");
  assert.equal(formatAgo(42_000), "42s");
  assert.equal(formatAgo(185_000), "3m");
  assert.equal(formatAgo(7_300_000), "2h");
});
