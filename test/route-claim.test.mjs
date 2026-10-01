import assert from "node:assert/strict";
import test from "node:test";

import { Config, PROVIDER, apply } from "../index.js";

// The generic pi-ai adapter declares a route for every provider in its installed
// catalog, and that catalog contains `openai-codex`. So on a real desktop
// composition this plugin always finds the route already declared, and aborting
// there is exactly what made the GPT models silently unavailable: the route
// existed with the generic adapter's empty model list, and `buildModelCatalog`
// drops empty groups, so the picker showed nothing and reported no error.
//
// This test pins the recovery: a DUPLICATE_DIRECTORY declaration must not stop
// this plugin from registering its own adapter, which replaces the generic one
// for that route.
function fakeContext({ declarationError } = {}) {
  const calls = { declared: 0, adapters: [] };
  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    fiber: {},
    effect() {},
    on() {},
    inject() {},
    provide() {},
    get() {
      return undefined;
    },
    llm: {
      registerConfigurableProviders() {
        calls.declared += 1;
        if (declarationError !== undefined) throw declarationError;
        return { replace() {} };
      },
      registerAdapter(providers, adapter) {
        calls.adapters.push({ providers, adapter });
        return { replace() {} };
      },
    },
  };
  return { ctx, calls };
}

function duplicateDeclarationError() {
  const error = new Error(`configurable provider "${PROVIDER}" is already declared`);
  error.code = "DUPLICATE_DIRECTORY";
  return error;
}

test("an already-declared route still gets this plugin's adapter", () => {
  const { ctx, calls } = fakeContext({ declarationError: duplicateDeclarationError() });
  apply(ctx, Config({}));

  assert.equal(calls.declared, 1, "the declaration was attempted");
  assert.equal(calls.adapters.length, 1, "the adapter was registered despite the conflict");
  assert.deepEqual(calls.adapters[0].providers, [PROVIDER]);
});

test("a fresh composition declares the route and registers the adapter", () => {
  const { ctx, calls } = fakeContext();
  apply(ctx, Config({}));

  assert.equal(calls.declared, 1);
  assert.equal(calls.adapters.length, 1);
});

test("an unexpected declaration failure still leaves a visible adapter", () => {
  const { ctx, calls } = fakeContext({ declarationError: new Error("unexpected") });
  apply(ctx, Config({}));

  assert.equal(calls.declared, 1);
  assert.equal(calls.adapters.length, 1, "activation continues so the failure stays visible");
});
