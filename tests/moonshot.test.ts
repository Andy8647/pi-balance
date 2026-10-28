import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { moonshotProvider } from "../src/providers/moonshot.ts";
import { DEFAULT_CONFIG, type FetchContext } from "../src/types.ts";

const NOW = Date.UTC(2026, 6, 20, 12);

function createContext(provider = "kimi-coding", baseUrl = "https://api.kimi.com/coding/v1") {
  return {
    model: { provider, id: "kimi-for-coding", baseUrl },
    baseUrl,
    headers: { Authorization: "Bearer test-key", "X-Custom": "kept" },
    config: { ...DEFAULT_CONFIG },
  } as FetchContext;
}

function mockResponses(t: TestContext, responses: (unknown | Response)[]) {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const requests: { url: string; headers: Headers }[] = [];
  t.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    requests.push({ url: String(input), headers: new Headers(init?.headers) });
    assert.ok(requests.length <= responses.length, `Unexpected request: ${input}`);
    const response = responses[requests.length - 1];
    return response instanceof Response ? response : Response.json(response);
  });
  return requests;
}

function window5(used: unknown = 44, resetTime?: unknown) {
  return {
    window: { duration: 5, timeUnit: "TIME_UNIT_HOUR" },
    detail: { limit: "100", used, resetTime },
  };
}

const balance = { code: 0, status: true, data: { available_balance: 12.5 } };

for (const [provider, baseUrl, expected] of [
  ["kimi-coding", "https://gateway.example/v1", true],
  ["kimi", "https://gateway.example/v1", true],
  ["kimi-custom", "https://gateway.example/v1", true],
  ["moonshot", "https://gateway.example/v1", true],
  ["custom", "https://api.kimi.com/coding/v1", true],
  ["custom", "https://api.moonshot.cn/v1", true],
  ["custom", "https://api.moonshot.ai/v1", true],
  ["kimix", "https://gateway.example/v1", false],
  ["custom", "https://kimi.com.example/v1", false],
  ["custom", "https://example.com/kimi.com/v1", false],
] as const) {
  test(`Moonshot/Kimi detection and support agree for ${provider} at ${baseUrl}`, () => {
    const context = createContext(provider, baseUrl);
    assert.equal(moonshotProvider.shouldTry(context.model, baseUrl), expected);
    const ctx = {
      modelRegistry: { getAll: () => [context.model], getAvailable: () => [context.model] },
    } as unknown as ExtensionContext;
    assert.equal(moonshotProvider.getSupport(ctx, DEFAULT_CONFIG).configured, expected);
  });
}

test("Moonshot retains the standard balance request and auth headers", async (t) => {
  const requests = mockResponses(t, [balance]);
  assert.deepEqual(
    await moonshotProvider.fetchBalance(createContext("moonshot", "https://api.moonshot.cn/v1")),
    { amount: 12.5, unit: "¥" },
  );
  assert.deepEqual(requests.map((request) => request.url), ["https://api.moonshot.cn/v1/users/me/balance"]);
  assert.equal(requests[0].headers.get("authorization"), "Bearer test-key");
  assert.equal(requests[0].headers.get("x-custom"), "kept");
});

test("Kimi displays remaining 5h and weekly quota with resets and enabled booster balance", async (t) => {
  const requests = mockResponses(t, [{
    usage: { limit: "1000", used: "200", resetTime: new Date(NOW + 6 * 86400000).toISOString() },
    limits: [window5("44", new Date(NOW + 150 * 60000).toISOString())],
    boosterWallet: { status: "STATUS_ENABLED", balance: { amountLeft: "1050000000" } },
  }]);
  assert.deepEqual(await moonshotProvider.fetchBalance(createContext()), {
    text: "Kimi: 5h·56%↺2h30m 7d·80%↺6d ¥10.50",
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api.kimi.com/coding/v1/usages");
  assert.equal(requests[0].headers.get("authorization"), "Bearer test-key");
  assert.equal(requests[0].headers.get("x-custom"), "kept");
});

test("Kimi accepts a weekly-only response", async (t) => {
  const requests = mockResponses(t, [{ usage: { limit: 100, remaining: 75 } }]);
  assert.deepEqual(await moonshotProvider.fetchBalance(createContext()), { text: "Kimi: 7d·75%" });
  assert.equal(requests.length, 1);
});

test("Kimi provider aliases query usage on a custom base URL", async (t) => {
  const requests = mockResponses(t, [{ limits: [window5(25)] }]);
  assert.deepEqual(
    await moonshotProvider.fetchBalance(createContext("kimi-coding", "https://gateway.example/v1")),
    { text: "Kimi: 5h·75%" },
  );
  assert.equal(requests[0].url, "https://gateway.example/v1/usages");
});

test("Kimi falls back from /v1/usages to /usages", async (t) => {
  const requests = mockResponses(t, [new Response(null, { status: 404 }), { limits: [window5(10)] }]);
  assert.deepEqual(await moonshotProvider.fetchBalance(createContext()), { text: "Kimi: 5h·90%" });
  assert.deepEqual(requests.map((request) => request.url), [
    "https://api.kimi.com/coding/v1/usages", "https://api.kimi.com/coding/usages",
  ]);
});

test("Kimi retains balance fallback when usage is unavailable", async (t) => {
  const requests = mockResponses(t, [new Response("not JSON"), {}, balance]);
  assert.deepEqual(await moonshotProvider.fetchBalance(createContext()), { amount: 12.5, unit: "¥" });
  assert.deepEqual(requests.map((request) => request.url), [
    "https://api.kimi.com/coding/v1/usages", "https://api.kimi.com/coding/usages",
    "https://api.kimi.com/coding/v1/users/me/balance",
  ]);
});

test("Kimi reads remaining when used is null and accepts nested usage payloads", async (t) => {
  mockResponses(t, [{ data: {
    limits: [{ window: { seconds: 18000 }, detail: { limit: 100, used: null, remaining: 60 } }],
  } }]);
  assert.deepEqual(await moonshotProvider.fetchBalance(createContext()), { text: "Kimi: 5h·60%" });
});

test("Kimi reads array payloads and weekly windows with numeric reset timestamps", async (t) => {
  mockResponses(t, [{ data: [
    { windowSeconds: "18000", limit_amount: "100", used_amount: "25", reset_at: (NOW + 60000) / 1000 },
    { window: { duration: 7, timeUnit: "TIME_UNIT_DAY" }, detail: { total: 100, used: 20, resetAt: NOW + 86400000 } },
  ] }]);
  assert.deepEqual(await moonshotProvider.fetchBalance(createContext()), {
    text: "Kimi: 5h·75%↺1m 7d·80%↺1d",
  });
});

for (const [used, remaining] of [[120, 0], [-10, 100]] as const) {
  test(`Kimi clamps remaining quota for used=${used}`, async (t) => {
    mockResponses(t, [{ limits: [window5(used)] }]);
    assert.deepEqual(await moonshotProvider.fetchBalance(createContext()), { text: `Kimi: 5h·${remaining}%` });
  });
}

for (const wallet of [
  { status: "STATUS_DISABLED", balance: { amountLeft: "1000000000" } },
  { status: "STATUS_ENABLED", balance: { amountLeft: "invalid" } },
  { status: "STATUS_ENABLED", balance: {} },
]) {
  test(`Kimi hides inactive or malformed booster data ${JSON.stringify(wallet)}`, async (t) => {
    mockResponses(t, [{ limits: [window5(0)], boosterWallet: wallet }]);
    assert.deepEqual(await moonshotProvider.fetchBalance(createContext()), { text: "Kimi: 5h·100%" });
  });
}

test("Kimi rounds reset durations across hour and day boundaries", async (t) => {
  mockResponses(t, [{
    limits: [window5(20, new Date(NOW + 3 * 3600000 - 1).toISOString())],
    usage: { limit: 100, used: 40, resetTime: new Date(NOW + 7 * 86400000 - 1).toISOString() },
  }]);
  assert.deepEqual(await moonshotProvider.fetchBalance(createContext()), {
    text: "Kimi: 5h·80%↺3h 7d·60%↺7d",
  });
});

test("Kimi omits invalid or expired reset times", async (t) => {
  mockResponses(t, [{ limits: [window5(20, "not-a-date")], usage: { limit: 100, used: 40, resetTime: new Date(NOW - 1).toISOString() } }]);
  assert.deepEqual(await moonshotProvider.fetchBalance(createContext()), { text: "Kimi: 5h·80% 7d·60%" });
});

test("Kimi skips malformed quota data and retains a valid fallback", async (t) => {
  mockResponses(t, [{ limits: [null, window5(null), window5(""), { window: { seconds: 18000 }, detail: { limit: -1, used: 1 } }] }, {}, balance]);
  assert.deepEqual(await moonshotProvider.fetchBalance(createContext()), { amount: 12.5, unit: "¥" });
});

test("Kimi does not issue requests after cancellation", async (t) => {
  const controller = new AbortController();
  let requestCount = 0;
  t.mock.method(globalThis, "fetch", (_input: unknown, init?: RequestInit) => {
    requestCount++;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  });
  const pending = moonshotProvider.fetchBalance(createContext(), controller.signal);
  assert.equal(requestCount, 1);
  controller.abort();
  assert.equal(await pending, undefined);
  assert.equal(requestCount, 1);
  assert.equal(await moonshotProvider.fetchBalance(createContext(), controller.signal), undefined);
  assert.equal(requestCount, 1);
});
