import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import balanceExtension from "../src/index.ts";
import { STATUS_KEY } from "../src/types.ts";

type Handler = (
  event: Record<string, unknown>,
  ctx: ExtensionContext,
) => unknown;

function createHarness(t: TestContext) {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const handlers = new Map<string, Handler>();
  const statuses: (string | undefined)[] = [];
  const requests: {
    url: string;
    signal: AbortSignal | null | undefined;
    resolve: (response: Response) => void;
  }[] = [];

  t.mock.method(globalThis, "fetch", (input: unknown, init?: RequestInit) => {
    const { promise, resolve } = Promise.withResolvers<Response>();
    requests.push({ url: String(input), signal: init?.signal, resolve });
    return promise;
  });

  const ctx = {
    model: {
      id: "deepseek-chat",
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com/v1",
    },
    ui: {
      setStatus(key: string, text: string | undefined) {
        assert.equal(key, STATUS_KEY);
        statuses.push(text);
      },
    },
    sessionManager: { getEntries: () => [] },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
      getProviderDisplayName: (provider: string) =>
        provider === "deepseek" ? "DeepSeek" : provider,
    },
  } as unknown as ExtensionContext;

  balanceExtension({
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    registerCommand() {},
  } as unknown as ExtensionAPI);

  const emit = async (type: string, event: Record<string, unknown> = {}) => {
    await handlers.get(type)?.({ ...event, type }, ctx);
    await setImmediate();
  };

  const respond = async (index: number, amount: number) => {
    assert.ok(requests[index], `Expected balance request ${index + 1}`);
    requests[index].resolve(Response.json({
      balance_infos: [{ total_balance: String(amount), currency: "CNY" }],
    }));
    await setImmediate();
  };

  t.after(() => emit("session_shutdown"));

  return { ctx, emit, respond, requests, statuses, status: () => statuses.at(-1) };
}

test("tries the dedicated balance API first and retains generic usage fallback", async (t) => {
  const h = createHarness(t);
  await h.emit("session_start");
  assert.equal(h.requests[0].url, "https://api.deepseek.com/user/balance");
  h.requests[0].resolve(new Response(null, { status: 404 }));
  await setImmediate();
  assert.equal(h.requests[1].url, "https://api.deepseek.com/v1/usage");
  h.requests[1].resolve(Response.json({ remaining: 12 }));
  await setImmediate();
  assert.equal(h.status(), "DeepSeek: $12.00");
});

test("refreshes after each assistant response without waiting for agent_end", async (t) => {
  const h = createHarness(t);
  await h.emit("session_start");
  await h.respond(0, 50);

  await h.emit("message_end", { message: { role: "user" } });
  await h.emit("message_end", { message: { role: "toolResult" } });
  assert.equal(h.requests.length, 1);

  await h.emit("message_end", { message: { role: "assistant" } });
  assert.equal(h.requests.length, 2);
  assert.equal(h.status(), "DeepSeek: ¥50.00");
  await h.respond(1, 49.5);
  assert.match(h.status()!, /^DeepSeek: ¥49\.50 /);
  assert.ok(h.status()!.includes("▼"));
});

test("polls every minute during a run and stops when the run ends", async (t) => {
  const h = createHarness(t);
  await h.emit("session_start");
  await h.respond(0, 50);
  t.mock.timers.tick(120_000);
  await setImmediate();
  assert.equal(h.requests.length, 1, "Idle sessions should not poll");

  await h.emit("agent_start");
  assert.equal(h.requests.length, 2);
  await h.respond(1, 50);

  t.mock.timers.tick(59_999);
  await setImmediate();
  assert.equal(h.requests.length, 2);
  t.mock.timers.tick(1);
  await setImmediate();
  assert.equal(h.requests.length, 3);
  await h.respond(2, 49);
  assert.match(h.status()!, /^DeepSeek: ¥49\.00 /);

  t.mock.timers.tick(60_000);
  await setImmediate();
  assert.equal(h.requests.length, 4);
  await h.respond(3, 48);

  await h.emit("agent_end");
  assert.equal(h.requests.length, 5, "Run completion should fetch the final balance");
  await h.respond(4, 47);
  t.mock.timers.tick(120_000);
  await setImmediate();
  assert.equal(h.requests.length, 5);
});

test("coalesces events during slow requests and fetches final charges after agent_end", async (t) => {
  const h = createHarness(t);
  await h.emit("session_start");
  await h.emit("agent_start");
  for (let index = 0; index < 3; index++) {
    await h.emit("message_end", { message: { role: "assistant" } });
  }

  t.mock.timers.tick(180_000);
  await setImmediate();
  assert.equal(h.requests.length, 1, "Slow fetches must not overlap or restart");
  assert.equal(h.requests[0].signal?.aborted, false);

  await h.emit("agent_end");
  await h.respond(0, 50);
  assert.equal(h.requests.length, 2, "Events should queue one follow-up fetch");
  await h.respond(1, 48);
  assert.match(h.status()!, /^DeepSeek: ¥48\.00 /);
  assert.equal(h.requests.length, 2);

  t.mock.timers.tick(120_000);
  await setImmediate();
  assert.equal(h.requests.length, 2);
});

test("poll ticks do not queue redundant fetches while a request is pending", async (t) => {
  const h = createHarness(t);
  await h.emit("session_start");
  await h.respond(0, 50);
  await h.emit("agent_start");
  await h.respond(1, 50);

  t.mock.timers.tick(60_000);
  await setImmediate();
  assert.equal(h.requests.length, 3);
  t.mock.timers.tick(180_000);
  await setImmediate();
  assert.equal(h.requests.length, 3);
  assert.equal(h.requests[2].signal?.aborted, false);
  await h.respond(2, 49);
  assert.equal(h.requests.length, 3, "A timer alone should not queue a follow-up");
  assert.match(h.status()!, /^DeepSeek: ¥49\.00 /);
});

test("switching models cancels old work and discards its queued refresh and late result", async (t) => {
  const h = createHarness(t);
  await h.emit("session_start");
  await h.respond(0, 50);
  await h.emit("agent_start");
  await h.emit("message_end", { message: { role: "assistant" } });

  h.ctx.model = {
    ...h.ctx.model!,
    id: "other-chat",
    provider: "other",
    baseUrl: "https://api.example.com/v1",
  };
  await h.emit("model_select");
  assert.equal(h.requests[1].signal?.aborted, true);
  assert.equal(h.status(), undefined, "A new provider must not display the old balance");
  assert.equal(h.requests.length, 3);

  h.requests[2].resolve(Response.json({ remaining: 20 }));
  await setImmediate();
  assert.equal(h.status(), "other: $20.00");
  await h.respond(1, 0);
  assert.equal(h.status(), "other: $20.00", "Late responses must not overwrite the new provider");
  assert.equal(h.requests.length, 3);
});

test("shutdown stops polling, aborts pending work, and allows a clean session restart", async (t) => {
  const h = createHarness(t);
  await h.emit("session_start");
  await h.respond(0, 50);
  await h.emit("agent_start");
  await h.emit("message_end", { message: { role: "assistant" } });
  await h.emit("session_shutdown");
  assert.equal(h.requests[1].signal?.aborted, true);
  assert.equal(h.status(), undefined);

  t.mock.timers.tick(120_000);
  await h.respond(1, 0);
  assert.equal(h.requests.length, 2, "Shutdown must drop queued refreshes");
  assert.equal(h.status(), undefined, "Late responses must not restore a cleared status");

  await h.emit("session_start");
  await h.respond(2, 22);
  assert.equal(h.status(), "DeepSeek: ¥22.00");
  t.mock.timers.tick(120_000);
  await setImmediate();
  assert.equal(h.requests.length, 3);
});
