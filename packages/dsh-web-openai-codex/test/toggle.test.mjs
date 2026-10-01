import assert from "node:assert/strict";
import test from "node:test";

import { createAgentWebToggle } from "../index.js";

function fakeAgent(id = "agent-1") {
  const registered = [];
  const disposed = [];
  const agent = {
    id,
    status: "idle",
    ctx: {
      systemPrompt: {
        section(section) {
          registered.push({ kind: "section", value: section });
          return () => disposed.push({ kind: "section", value: section });
        },
      },
      tools: {
        register(tool) {
          registered.push({ kind: "tool", value: tool });
          return () => disposed.push({ kind: "tool", value: tool });
        },
      },
    },
  };
  return { agent, registered, disposed };
}

function baseOptions(enabled) {
  return {
    enabled,
    searchMaxResults: 8,
    searchTimeoutMs: 60_000,
    searchMaxOutputTokens: 4096,
    assistantContextTokens: 1000,
    fetchTimeoutMs: 60_000,
    fetchMaxResponseBytes: 5 * 1024 * 1024,
    fetchMaxBodyChars: 100_000,
    fetchMaxRedirects: 5,
    fetchMaxUrlLength: 2048,
    fetchMaxOutputChars: 200_000,
  };
}

test("combined switch is off by default and installs both standard tools together", () => {
  const fixture = fakeAgent();
  let config = baseOptions(false);
  const agents = { list: () => [fixture.agent] };
  const toggle = createAgentWebToggle({
    agents,
    searchProvider: { search() {} },
    makeFetchProvider: () => ({ fetch() {} }),
    options: () => config,
    logger: { error() {}, warn() {} },
  });

  toggle.reconcileAll();
  assert.equal(fixture.registered.length, 0);
  config = baseOptions(true);
  toggle.reconcileAll();
  assert.deepEqual(
    fixture.registered.map((item) => `${item.kind}:${item.value.name}`),
    ["section:tool:web_search", "tool:web_search", "section:tool:web_fetch", "tool:web_fetch"],
  );
  assert.equal(toggle.installed.size, 1);
});

test("web search normalizes and forwards its single query", async () => {
  const fixture = fakeAgent();
  let received;
  const toggle = createAgentWebToggle({
    agents: { list: () => [fixture.agent] },
    searchProvider: {
      async search(input) {
        received = input;
        return { sources: [], truncated: false };
      },
    },
    makeFetchProvider: () => ({ fetch() {} }),
    options: () => baseOptions(true),
    logger: { error() {}, warn() {} },
  });

  toggle.reconcileAll();
  const tool = fixture.registered.find((item) => item.kind === "tool" && item.value.name === "web_search").value;
  await tool.execute({ query: " current facts " }, {});

  assert.deepEqual(received, { query: "current facts", maxResults: 8 });
  await assert.rejects(() => tool.execute({ query: "   " }, {}), /query must be a non-empty string/);
});

test("a running agent defers the whole switch until idle", () => {
  const fixture = fakeAgent();
  let config = baseOptions(true);
  const toggle = createAgentWebToggle({
    agents: { list: () => [fixture.agent] },
    searchProvider: { search() {} },
    makeFetchProvider: () => ({ fetch() {} }),
    options: () => config,
    logger: { error() {}, warn() {} },
  });
  toggle.reconcileAll();
  assert.equal(fixture.registered.length, 4);

  fixture.agent.status = "running";
  config = baseOptions(false);
  toggle.reconcileAll();
  assert.equal(fixture.disposed.length, 0);
  assert.equal(toggle.installed.size, 1);

  fixture.agent.status = "idle";
  toggle.reconcileAll();
  assert.equal(fixture.disposed.length, 4);
  assert.equal(toggle.installed.size, 0);
});

test("failed cleanup keeps a retryable registration before fallback", () => {
  const fixture = fakeAgent();
  let failOnce = true;
  const originalRegister = fixture.agent.ctx.tools.register;
  fixture.agent.ctx.tools.register = (tool) => {
    const dispose = originalRegister(tool);
    if (tool.name !== "web_fetch") return dispose;
    return () => {
      if (failOnce) {
        failOnce = false;
        throw new Error("transient dispose failure");
      }
      dispose();
    };
  };
  let config = baseOptions(true);
  const toggle = createAgentWebToggle({
    agents: { list: () => [fixture.agent] },
    searchProvider: { search() {} },
    makeFetchProvider: () => ({ fetch() {} }),
    options: () => config,
    logger: { error() {}, warn() {} },
  });
  toggle.reconcileAll();
  config = baseOptions(false);
  toggle.reconcileAll();
  assert.equal(toggle.installed.size, 1);
  toggle.reconcileAll();
  assert.equal(toggle.installed.size, 0);
});

test("enabled configuration changes replace registrations only at idle", () => {
  const fixture = fakeAgent();
  let config = baseOptions(true);
  const toggle = createAgentWebToggle({
    agents: { list: () => [fixture.agent] },
    searchProvider: { search() {} },
    makeFetchProvider: () => ({ fetch() {} }),
    options: () => config,
    logger: { error() {}, warn() {} },
  });
  toggle.reconcileAll();
  fixture.agent.status = "running";
  config = { ...baseOptions(true), searchMaxResults: 4 };
  toggle.reconcileAll();
  assert.equal(fixture.registered.length, 4);
  assert.equal(fixture.disposed.length, 0);

  fixture.agent.status = "idle";
  toggle.reconcileAll();
  assert.equal(fixture.registered.length, 8);
  assert.equal(fixture.disposed.length, 4);
  toggle.disposeAll();
  assert.equal(fixture.disposed.length, 8);
});
