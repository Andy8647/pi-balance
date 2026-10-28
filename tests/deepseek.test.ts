import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { deepseekProvider } from "../src/providers/deepseek.ts";
import type { FetchContext } from "../src/types.ts";

const context = {
  baseUrl: "https://api.deepseek.com/v1",
  headers: { Authorization: "Bearer test-key" },
} as FetchContext;

function mockBalance(t: TestContext, balanceInfos: unknown, rate?: string) {
  const previousRate = process.env.PI_BALANCE_CNY_RATE;
  if (rate === undefined) delete process.env.PI_BALANCE_CNY_RATE;
  else process.env.PI_BALANCE_CNY_RATE = rate;
  t.after(() => {
    if (previousRate === undefined) delete process.env.PI_BALANCE_CNY_RATE;
    else process.env.PI_BALANCE_CNY_RATE = previousRate;
  });

  return t.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    assert.equal(String(input), "https://api.deepseek.com/user/balance");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-key");
    return Response.json({ balance_infos: balanceInfos });
  });
}

for (const reverse of [false, true]) {
  test(`DeepSeek keeps currencies separate with ${reverse ? "USD" : "CNY"} first`, async (t) => {
    const infos = [
      { currency: "CNY", total_balance: "80" },
      { currency: "USD", total_balance: "0" },
    ];
    mockBalance(t, reverse ? infos.reverse() : infos);
    assert.deepEqual(await deepseekProvider.fetchBalance(context), { amount: 80, unit: "¥" });
  });
}

test("DeepSeek chooses from final per-currency totals", async (t) => {
  mockBalance(t, [
    { currency: "cny", total_balance: "100" },
    { currency: "USD", total_balance: "30" },
    { currency: " CNY ", total_balance: "-90" },
    { currency: "usd", total_balance: "50" },
  ]);
  assert.deepEqual(await deepseekProvider.fetchBalance(context), { amount: 80, unit: "$" });
});

for (const reverse of [false, true]) {
  test(`DeepSeek resolves equal balances consistently (${reverse ? "reversed" : "original"})`, async (t) => {
    const infos = [
      { currency: "CNY", total_balance: "10" },
      { currency: "USD", total_balance: "10" },
    ];
    mockBalance(t, reverse ? infos.reverse() : infos);
    assert.deepEqual(await deepseekProvider.fetchBalance(context), { amount: 10, unit: "¥" });
  });
}

test("DeepSeek displays an exhausted account as zero", async (t) => {
  mockBalance(t, [
    { currency: "USD", total_balance: "0" },
    { currency: "CNY", total_balance: "0" },
  ]);
  assert.deepEqual(await deepseekProvider.fetchBalance(context), { amount: 0, unit: "¥" });
});

test("DeepSeek preserves debt instead of hiding it behind an empty currency", async (t) => {
  mockBalance(t, [
    { currency: "CNY", total_balance: "-2.5" },
    { currency: "USD", total_balance: "0" },
  ]);
  assert.deepEqual(await deepseekProvider.fetchBalance(context), { amount: -2.5, unit: "¥" });
});

test("DeepSeek converts the selected USD balance when a valid rate is configured", async (t) => {
  mockBalance(t, [{ currency: "USD", total_balance: "10" }], "7.2");
  assert.deepEqual(await deepseekProvider.fetchBalance(context), { amount: 72, unit: "¥" });
});

for (const rate of ["invalid", "0", "-1", "Infinity", "1e309"]) {
  test(`DeepSeek ignores invalid CNY conversion rate ${rate}`, async (t) => {
    mockBalance(t, [{ currency: "USD", total_balance: "10" }], rate);
    assert.deepEqual(await deepseekProvider.fetchBalance(context), { amount: 10, unit: "$" });
  });
}

test("DeepSeek ignores a conversion that would overflow", async (t) => {
  mockBalance(t, [{ currency: "USD", total_balance: "1e308" }], "10");
  assert.deepEqual(await deepseekProvider.fetchBalance(context), { amount: 1e308, unit: "$" });
});

test("DeepSeek ignores malformed entries without losing a valid currency", async (t) => {
  mockBalance(t, [null, {}, { currency: "USD", total_balance: "invalid" },
    { total_balance: "90" }, { currency: "", total_balance: "100" },
    { currency: "EUR", total_balance: "3.5" }]);
  assert.deepEqual(await deepseekProvider.fetchBalance(context), { amount: 3.5, unit: "EUR" });
});

for (const infos of [undefined, [], [null, {}, { currency: "CNY", total_balance: "NaN" }]]) {
  test(`DeepSeek returns no result for invalid balance data ${JSON.stringify(infos)}`, async (t) => {
    mockBalance(t, infos);
    assert.equal(await deepseekProvider.fetchBalance(context), undefined);
  });
}
