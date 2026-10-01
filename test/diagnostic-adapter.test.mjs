import assert from "node:assert/strict";
import test from "node:test";

import { diagnosticAdapter } from "../index.js";

// The Electron host's stderr is not read by anyone, so a log-only registration
// failure is indistinguishable from "the models never appeared". The diagnostic
// adapter guarantees the failure is visible where the user looks: `listModels`
// returns one entry whose name carries the reason, because the GUI catalog drops
// provider groups with an empty model list.
test("the diagnostic adapter advertises one visible, self-explanatory model", async () => {
  const adapter = diagnosticAdapter("adapter registration failed: boom");
  const models = await adapter.listModels("openai-codex");

  assert.equal(models.length, 1);
  assert.equal(models[0].provider, "openai-codex");
  assert.match(models[0].name, /adapter registration failed: boom/);
});

test("the diagnostic adapter resolves exact model metadata the GUI validates", async () => {
  const adapter = diagnosticAdapter("boom");
  const models = await adapter.listModels("openai-codex");
  const info = await adapter.resolveModel("openai-codex", models[0].id);

  assert.equal(info.provider, "openai-codex");
  assert.equal(info.id, models[0].id);
  assert.ok(typeof info.name === "string" && info.name.length > 0);
  assert.ok(Array.isArray(info.inputModalities));
  assert.ok(Number.isInteger(info.context.contextWindow) && info.context.contextWindow > 0);
  assert.deepEqual(adapter.providerInfo("openai-codex"), { id: "openai-codex", name: "OpenAI (ChatGPT)" });
});

test("the diagnostic adapter refuses to serve a request instead of pretending", () => {
  const adapter = diagnosticAdapter("boom");
  assert.throws(() => adapter.stream(), /boom/);
  assert.throws(() => adapter.streamSimple(), /boom/);
});
