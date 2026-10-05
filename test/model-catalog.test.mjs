import assert from "node:assert/strict";
import test from "node:test";
import { zstdDecompressSync } from "node:zlib";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { supplementCodexCatalog } from "../codex-catalog.mjs";
import { PROVIDER, buildProfile, createDshAdapter, createSubscriptionPiProvider, gptModelCatalog } from "../index.js";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const TOKEN = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.signature`;

test("the catalog backport preserves a future host descriptor without duplicating it", () => {
  const native = { id: "gpt-6.1-sol", contextWindow: 300000 };
  const input = [native];
  assert.deepEqual(supplementCodexCatalog(input), input);
  assert.equal(supplementCodexCatalog(input)[0], native);
  assert.equal(input.length, 1);
  const first = supplementCodexCatalog([]);
  first[0].cost.cacheRead = 99;
  assert.equal(supplementCodexCatalog([])[0].cost.cacheRead, 0.1);
});

test("GPT-6.1 Sol Standard and Fast offer only supported reasoning efforts", () => {
  const catalog = gptModelCatalog();
  for (const id of ["gpt-6.1-sol", "gpt-6.1-sol-fast"]) {
    const model = catalog.find((entry) => entry.id === id);
    assert.ok(model, `${id} must be selectable`);
    assert.deepEqual(getSupportedThinkingLevels(model), EFFORTS);
    assert.equal(model.contextWindow, 272000);
    assert.equal(model.maxTokens, 128000);
    assert.deepEqual(model.input, ["text", "image"]);
  }
});

test("existing selectors preserve the shared catalog's reasoning capabilities", () => {
  const catalog = gptModelCatalog();
  for (const upstream of openaiCodexProvider().getModels()) {
    const selected = catalog.find(model => model.id === upstream.id);
    if (selected === undefined) continue;
    const expected = getSupportedThinkingLevels(upstream).filter(level => level !== "minimal");
    assert.deepEqual(getSupportedThinkingLevels(selected), expected, upstream.id);
    const fast = catalog.find(model => model.id === `${upstream.id}-fast`);
    if (fast !== undefined) assert.deepEqual(getSupportedThinkingLevels(fast), expected, fast.id);
  }
});

test("a retired subscription model is not offered by the model picker", () => {
  assert.ok(!gptModelCatalog().some(model => model.id === "gpt-5.3-codex-spark"));
});

test("the actual Harness adapter resolves both new selector ids", async () => {
  const profile = buildProfile(createSubscriptionPiProvider(), {
    baseURL: "https://chatgpt.com/backend-api",
    streamIdleTimeoutMs: 300000,
    retryPolicy: undefined,
  });
  const auth = { credentials: {}, authContext: {} };
  const adapter = createDshAdapter({ get() {} }, () => new Map([[PROVIDER, profile]]), async () => TOKEN, auth);
  const listed = await adapter.listModels(PROVIDER);
  for (const id of ["gpt-6.1-sol", "gpt-6.1-sol-fast"]) {
    assert.ok(listed.some((model) => model.id === id));
    const resolved = await adapter.resolveModel(PROVIDER, id);
    assert.equal(resolved.defaultMaxTokens, 128000);
    assert.deepEqual(resolved.reasoning.efforts.map((effort) => effort.id), EFFORTS);
  }
});

function okResponse() {
  const item = { id: "msg-test", type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "OK", annotations: [] }] };
  const events = [
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "OK" },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "resp-test", status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } } },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

test("the shared 0.87.1 transport sends GPT-6.1 Sol efforts, tools, and Fast tier correctly", async () => {
  const provider = createSubscriptionPiProvider();
  for (const id of ["gpt-6.1-sol", "gpt-6.1-sol-fast"]) {
    const model = provider.getModels().find((entry) => entry.id === id);
    for (const effort of EFFORTS) {
      let payload;
      const events = await Array.fromAsync(provider.streamSimple(model, {
        messages: [
          { role: "system", content: "Use tools when needed", toolsAdded: [{ name: "echo", description: "Echo a value", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } }] },
          { role: "user", content: "Reply OK" },
        ],
      }, {
        apiKey: TOKEN,
        reasoning: effort,
        transport: "sse",
        maxRetries: 0,
        fetch: async (url, init) => {
          assert.equal(url, "https://chatgpt.com/backend-api/codex/responses");
          const body = init.headers.get("content-encoding") === "zstd"
            ? zstdDecompressSync(init.body).toString("utf8")
            : init.body;
          payload = JSON.parse(body);
          return okResponse();
        },
      }));
      assert.ok(payload, events.at(-1)?.error?.errorMessage ?? "transport did not dispatch");
      assert.equal(payload.model, "gpt-6.1-sol");
      assert.equal(payload.reasoning.effort, effort);
      assert.equal(payload.service_tier, id.endsWith("-fast") ? "priority" : undefined);
      assert.equal(payload.tools[0].name, "echo");
      const final = events.at(-1);
      assert.equal(final.type, "done", final.error?.errorMessage);
      assert.equal(final.message.model, id, "Fast must retain the selector id for follow-up replay");
      assert.equal(final.message.content.find((block) => block.type === "text").text, "OK");
    }
  }
});
