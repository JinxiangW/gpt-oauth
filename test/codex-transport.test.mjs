import assert from "node:assert/strict";
import test from "node:test";

import {
  Config,
  createOpenAiCodexTransport,
  extractChatGptAccountId,
  validateCodexTransportRequest,
} from "../index.js";

function jwt(payload) {
  const head = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${head}.${body}.signature`;
}

const TOKEN = jwt({
  "https://api.openai.com/auth": { chatgpt_account_id: "acct-test" },
});

test("llm-openai settings stay scoped to the LLM adapter", () => {
  const resolved = Config({});
  assert.equal(resolved.baseURL, "https://chatgpt.com/backend-api");
  assert.equal("codexWeb" in resolved, false);
});

test("extractChatGptAccountId accepts only a valid account claim", () => {
  assert.equal(extractChatGptAccountId(TOKEN), "acct-test");
  assert.throws(() => extractChatGptAccountId("not-a-jwt"), /failed to decode/);
  assert.throws(() => extractChatGptAccountId(jwt({})), /no chatgpt_account_id/);
});

test("Codex transport permits only the fixed search path and POST", () => {
  assert.deepEqual(
    validateCodexTransportRequest({ path: "alpha/search", method: "POST", body: { query: "x" } }),
    { path: "alpha/search", method: "POST", body: { query: "x" }, signal: undefined },
  );
  for (const request of [
    { path: "https://evil.example", body: {} },
    { path: "../responses", body: {} },
    { path: "alpha/search", method: "GET", body: {} },
  ]) {
    assert.throws(() => validateCodexTransportRequest(request), /not allowed|only permits/);
  }
});

test("Codex transport fixes origin and credential headers", async () => {
  const calls = [];
  const transport = createOpenAiCodexTransport({
    resolveAccessToken: async () => TOKEN,
    fetcher: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });
  const body = { id: "session", commands: { search_query: [{ q: "test" }] } };
  const response = await transport.request({ path: "alpha/search", method: "POST", body });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://chatgpt.com/backend-api/codex/alpha/search");
  assert.equal(calls[0].init.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].init.headers["chatgpt-account-id"], "acct-test");
  assert.equal(calls[0].init.headers.originator, "dsh");
  assert.equal(calls[0].init.redirect, "error");
  assert.deepEqual(JSON.parse(calls[0].init.body), body);
});

test("Codex transport reports missing credentials without network access", async () => {
  let calls = 0;
  const transport = createOpenAiCodexTransport({
    resolveAccessToken: async () => undefined,
    fetcher: async () => {
      calls += 1;
    },
  });
  await assert.rejects(
    transport.request({ path: "alpha/search", body: {} }),
    (error) => error.code === "MISSING_CREDENTIAL" && !error.message.includes("Bearer"),
  );
  assert.equal(calls, 0);
});
