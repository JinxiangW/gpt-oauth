import assert from "node:assert/strict";
import test from "node:test";

import { PROVIDER, buildProfile, createSubscriptionPiProvider } from "../index.js";

// PiAiAdapter.modelOf() reads `profile.modelErrors` and `profile.catalogError` on
// every model lookup. A profile without them makes resolveModel() throw, which
// makes the GUI model catalog turn the whole provider into a failure and then
// drop the empty group — the provider silently disappears from the model picker
// instead of reporting an error.
test("the adapter profile carries the diagnostics PiAiAdapter reads", () => {
  const profile = buildProfile(createSubscriptionPiProvider(), {
    baseURL: "https://chatgpt.com/backend-api",
    streamIdleTimeoutMs: 300_000,
    retryPolicy: undefined,
  });

  assert.equal(profile.provider, PROVIDER);
  assert.ok(profile.modelErrors instanceof Map, "modelErrors must be a Map");
  assert.equal(profile.modelErrors.size, 0);
  assert.ok(Object.hasOwn(profile, "catalogError"), "catalogError must be an own property");
  assert.equal(profile.catalogError, undefined);
  assert.ok(profile.piProvider !== undefined, "piProvider must be present");
  assert.ok(profile.configuredMaxTokens instanceof Map && profile.configuredMaxTokens.size > 0);
});

test("every advertised model id has a max-token entry for model resolution", () => {
  const profile = buildProfile(createSubscriptionPiProvider(), {
    baseURL: "https://chatgpt.com/backend-api",
    streamIdleTimeoutMs: 300_000,
    retryPolicy: undefined,
  });
  const ids = profile.piProvider.getModels().map((model) => model.id);
  assert.ok(ids.length > 0);
  for (const id of ids) {
    assert.ok(profile.configuredMaxTokens.has(id), `missing configuredMaxTokens for ${id}`);
  }
});
