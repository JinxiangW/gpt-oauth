import assert from "node:assert/strict";
import test from "node:test";

import {
  CodexSearchProvider,
  buildCodexSearchRequest,
  codexWireModel,
  mapCodexSearchResponse,
  recentCodexSearchInput,
} from "../lib/codex-search.js";

function message(role, blocks, source = role === "assistant" ? { kind: "model" } : role === "user" ? { kind: "user" } : { kind: "plugin" }) {
  return { role, content: blocks, source };
}
function text(role, value) {
  return message(role, [{ type: "text", text: value }]);
}
function session({ provider = "openai-codex", model = "gpt-5.6-sol-fast", messages = [] } = {}) {
  return {
    id: "session-test",
    requestContext: () => ({ provider, model }),
    deriveMessages: () => messages,
  };
}

test("recent Codex input keeps two user messages and bounded assistant text only", () => {
  const input = recentCodexSearchInput([
    text("system", "secret system"),
    text("user", "old user"),
    text("assistant", "old assistant"),
    text("user", "previous user"),
    message("assistant", [
      { type: "reasoning", text: "hidden" },
      { type: "text", text: "abcdefghij" },
      { type: "tool-call", name: "x", arguments: "{}", id: "call" },
    ]),
    message("user", [{ type: "tool-result", toolCallId: "call", content: [{ type: "text", text: "tool secret" }] }], { kind: "tool" }),
    message("user", [{ type: "image", attachment: {} }, { type: "text", text: "current user" }]),
    text("assistant", "later commentary"),
  ], 1);
  assert.deepEqual(input, [
    { type: "message", role: "user", content: [{ type: "input_text", text: "previous user" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "abcd" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "current user" }] },
  ]);
  assert.equal(JSON.stringify(input).includes("secret"), false);
  assert.equal(JSON.stringify(input).includes("hidden"), false);
});

test("build request inherits and normalizes the current DSH model", () => {
  const request = buildCodexSearchRequest({
    session: session({ messages: [text("user", "find it")] }),
    query: " latest facts ",
    maxResults: 3,
    assistantContextTokens: 1000,
    maxOutputTokens: 2048,
  });
  assert.equal(request.id, "session-test");
  assert.equal(request.model, "gpt-5.6-sol");
  assert.equal(request.commands.search_query[0].q, "latest facts");
  assert.equal(request.commands.response_length, "short");
  assert.equal(request.settings.external_web_access, true);
  assert.deepEqual(request.settings.allowed_callers, ["direct"]);
  assert.equal(request.max_output_tokens, 2048);
  assert.equal(codexWireModel("gpt-5.4-mini"), "gpt-5.4-mini");
});

test("build request rejects unsupported current provider without fallback", () => {
  assert.throws(
    () => buildCodexSearchRequest({ session: session({ provider: "deepseek" }), query: "x" }),
    (error) => error.code === "WEB_CODEX_PROVIDER_MISMATCH",
  );
});

test("maps only known text_result URLs, de-duplicates, and truncates", () => {
  const mapped = mapCodexSearchResponse({
    output: "answer",
    results: [
      { type: "future_result", url: "https://unknown.example/", future_field: true },
      { type: "text_result", ref_id: "turn0search0", url: "https://example.com/a", title: "A", snippet: "first" },
      { type: "text_result", ref_id: "turn0search1", url: "https://example.com/b", published_at: "2026-01-02" },
      { type: "text_result", url: "https://example.com/a", title: "duplicate" },
      { type: "text_result", url: "file:///secret", title: "bad" },
    ],
  }, 1);
  assert.deepEqual(mapped, {
    content: "answer",
    sources: [{ url: "https://example.com/a", title: "A", snippet: "first" }],
    truncated: true,
  });
});

test("caps answer and citation metadata lengths", () => {
  const mapped = mapCodexSearchResponse({
    output: "x".repeat(1_000_001),
    results: [{ type: "text_result", url: "https://example.com/", title: "t".repeat(1_001), snippet: "s".repeat(10_001) }],
  });
  assert.equal(mapped.content.length, 1_000_000);
  assert.equal(mapped.sources[0].title.length, 1_000);
  assert.equal(mapped.sources[0].snippet.length, 10_000);
  assert.equal(mapped.truncated, true);
});

test("fails a source-less answer instead of returning ungrounded content", () => {
  assert.throws(
    () => mapCodexSearchResponse({ output: "answer", results: [{ type: "opaque" }] }),
    (error) => error.code === "WEB_CODEX_CITATIONS_MISSING",
  );
});

test("provider rejects oversized search responses before parsing", async () => {
  const provider = new CodexSearchProvider({
    transport: {
      async request() {
        return new Response("oversized", {
          status: 200,
          headers: { "content-type": "application/json", "content-length": String(2 * 1024 * 1024 + 1) },
        });
      },
    },
    resolveOptions: () => ({ assistantContextTokens: 1000, searchMaxOutputTokens: 4096 }),
  });
  const agent = { session: session({ messages: [text("user", "question")] }) };
  await assert.rejects(
    provider.search({ query: "question", maxResults: 8 }, undefined, agent),
    (error) => error.code === "WEB_CODEX_RESPONSE_TOO_LARGE",
  );
});

test("provider cancels an unbounded streaming search response", async () => {
  let chunks = 0;
  let cancelled = false;
  const provider = new CodexSearchProvider({
    transport: {
      async request() {
        return new Response(new ReadableStream({
          pull(controller) {
            chunks += 1;
            controller.enqueue(new Uint8Array(1024 * 1024));
          },
          cancel() {
            cancelled = true;
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    },
    resolveOptions: () => ({ assistantContextTokens: 1000, searchMaxOutputTokens: 4096 }),
  });
  const agent = { session: session({ messages: [text("user", "question")] }) };
  await assert.rejects(
    provider.search({ query: "question", maxResults: 8 }, undefined, agent),
    (error) => error.code === "WEB_CODEX_RESPONSE_TOO_LARGE",
  );
  assert.equal(cancelled, true);
  assert.ok(chunks >= 3 && chunks <= 4, `unexpected stream prefetch: ${chunks}`);
});

test("provider sends alpha/search request and maps response", async () => {
  const calls = [];
  const provider = new CodexSearchProvider({
    transport: {
      async request(call) {
        calls.push(call);
        return new Response(JSON.stringify({
          output: "answer",
          results: [{ type: "text_result", ref_id: "turn0search0", url: "https://example.com/" }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    },
    resolveOptions: () => ({ assistantContextTokens: 1000, searchMaxOutputTokens: 4096 }),
  });
  const agent = { session: session({ messages: [text("user", "question")] }) };
  const result = await provider.search({ query: "question", maxResults: 8 }, undefined, agent);
  assert.equal(calls[0].path, "alpha/search");
  assert.equal(calls[0].body.model, "gpt-5.6-sol");
  assert.deepEqual(result.sources, [{ url: "https://example.com/" }]);
});
