import assert from "node:assert/strict";
import test from "node:test";
import { Config, apply } from "../index.js";

test("the config observer preserves downstream configuration for every fiber", () => {
  let observer;
  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    fiber: {},
    effect() {},
    on(event, handler) { if (event === "internal/config") observer = handler; },
    inject() {},
    provide() {},
    get() {},
    llm: {
      registerConfigurableProviders() { return { replace() {} }; },
      registerAdapter() { return { replace() {} }; },
    },
  };
  apply(ctx, Config({}));
  assert.equal(typeof observer, "function");
  for (const fiber of [{}, ctx.fiber]) {
    const raw = { source: "bundled-runtime" };
    const resolved = { ...raw, downstream: true };
    let nextCalls = 0;
    const result = observer.call(fiber, raw, () => {
      nextCalls++;
      return resolved;
    });
    assert.equal(nextCalls, 1);
    assert.equal(result, resolved);
    assert.deepEqual(raw, { source: "bundled-runtime" });
  }
});
