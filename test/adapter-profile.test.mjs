import assert from "node:assert/strict";
import test from "node:test";

import { PROVIDER, buildProfile, createDshAdapter, createSubscriptionPiProvider } from "../index.js";

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
  assert.equal(profile.requestImagePixelBudget, 4_194_304);
  assert.equal(profile.requestImageMaxBytes, 1_048_576);
  assert.equal(profile.maxRequestImageBytes, 20_971_520);
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

// Go through the real PiAiAdapter image conversion, but stop at a fake provider:
// no OAuth credential or network request is needed for this regression.
for (const [modelId, width, height] of [
  ["gpt-6.1-sol", 640, 480],
  ["gpt-6.1-sol", 8000, 4000],
  ["gpt-6.1-sol", 4000, 8000],
  ["gpt-6.1-sol-fast", 640, 480],
  ["gpt-6.1-sol-fast", 8000, 4000],
  ["gpt-6.1-sol-fast", 4000, 8000],
]) {
  test(`${modelId}: pasted ${width}x${height} image gets a valid bounded request target`, async () => {
    let context;
    const profile = buildProfile({
      stream(...args) { return this.streamSimple(...args); },
      async *streamSimple(model, input) {
        context = input;
        yield { type: "done", reason: "stop", message: {
          role: "assistant", content: [{ type: "text", text: "OK" }],
          api: model.api, provider: model.provider, model: model.id,
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop", timestamp: 0,
        } };
      },
    }, {
      baseURL: "https://chatgpt.com/backend-api",
      streamIdleTimeoutMs: 300_000,
      retryPolicy: undefined,
    });
    const data = new Uint8Array([1, 2, 3]);
    let imageReads = 0;
    const attachment = {
      attachmentId: "sha256:test-pasted-image",
      mediaType: "image/png",
      bytes: data.byteLength,
      width,
      height,
    };
    const attachments = {
      async readImageRequest(ref, target) {
        imageReads += 1;
        assert.equal(ref, attachment);
        for (const key of ["width", "height", "maxBytes"]) {
          assert.ok(Number.isSafeInteger(target[key]) && target[key] > 0,
            `Image request ${key} must be a positive integer.`);
        }
        assert.ok(target.width <= width && target.height <= height);
        assert.ok(target.width * target.height <= 4_194_304);
        assert.equal(target.maxBytes, 1_048_576);
        return { ...target, variantId: "sha256:test-variant", mediaType: "image/png", bytes: data.byteLength, data };
      },
    };
    const adapter = createDshAdapter({
      get(service) {
        assert.equal(service, "attachments");
        return attachments;
      },
    }, () => new Map([[PROVIDER, profile]]), async () => "test-only-api-key", {
      credentials: {}, authContext: {},
    });
    const chunks = await Array.fromAsync(adapter.stream({
      provider: PROVIDER,
      model: modelId,
      messages: [{ role: "user", content: [{ type: "image", attachment }] }],
    }));
    assert.equal(chunks.at(-1).type, "finish");
    assert.deepEqual(chunks.at(-1).reason, { kind: "stop" });
    assert.equal(imageReads, 1);
    const image = context.messages[0].content.find(block => block.type === "image");
    assert.equal(image.mimeType, "image/png");
    assert.equal(image.data, Buffer.from(data).toString("base64"));
  });
}
