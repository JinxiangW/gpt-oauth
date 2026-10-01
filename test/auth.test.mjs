import assert from "node:assert/strict";
import test from "node:test";

import {
  OAUTH_CREDENTIAL_KEY,
  createOpenAiCredentialStore,
  credentialFromRecord,
  grantRecord,
  registerOpenAiAuthorizationFlow,
} from "../auth.mjs";

const TOKEN = Object.freeze({ type: "oauth", access: "access", refresh: "refresh", expires: Date.now() + 60_000 });

function fakeCredentials() {
  const records = new Map();
  return {
    records,
    async readRecord(key) { return records.get(key); },
    async listRecords() {
      return [...records].map(([key, record]) => ({ key, kind: record.kind }));
    },
    async modifyRecord(key, mutate) {
      const next = await mutate(records.get(key));
      if (next !== undefined) records.set(key, next);
      return records.get(key);
    },
    async deleteRecord(key) { records.delete(key); },
  };
}

test("OAuth grants use the plugin-owned DSH credential record", async () => {
  const credentials = fakeCredentials();
  const store = createOpenAiCredentialStore(
    { get: (name) => name === "credentials" ? credentials : undefined },
    { readLegacy: async () => undefined, removeLegacy: false },
  );

  await store.modify("openai-codex", async () => TOKEN);
  assert.deepEqual(credentialFromRecord(credentials.records.get(OAUTH_CREDENTIAL_KEY)), TOKEN);
  assert.deepEqual(await store.read("openai-codex"), TOKEN);
  assert.deepEqual(await store.list(), [{ providerId: "openai-codex", type: "oauth" }]);

  await store.modify("openai-codex", async (current) => ({ ...current, access: "rotated" }));
  assert.equal((await store.read("openai-codex")).access, "rotated");
  await store.delete("openai-codex");
  assert.equal(await store.read("openai-codex"), undefined);
});

test("OAuth record validation rejects malformed grants", () => {
  assert.throws(() => grantRecord({ type: "oauth", access: "only-access" }), /invalid/);
  assert.equal(credentialFromRecord({ kind: "grant", payload: { type: "api_key", key: "x" } }), undefined);
});

test("authorization flow advertises browser and device methods", () => {
  let flow;
  const ctx = {
    authorization: {
      registerFlow(value) {
        flow = value;
        return () => {};
      },
    },
  };
  registerOpenAiAuthorizationFlow(ctx);
  assert.equal(flow.key, OAUTH_CREDENTIAL_KEY);
  assert.deepEqual(flow.methods.map(({ id }) => id), ["browser", "device-code"]);
  assert.equal(typeof flow.run, "function");
});
