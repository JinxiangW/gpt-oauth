import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../smoke-test.mjs";

test("catalog-only smoke does not resolve credentials", async () => {
  let credentialReads = 0;
  const code = await main(["--no-call"], {
    resolveAccess: async () => {
      credentialReads += 1;
      throw new Error("must not be called");
    },
  });
  assert.equal(code, 0);
  assert.equal(credentialReads, 0);
});

test("smoke returns nonzero for non-throwing provider errors", async () => {
  const collection = {
    setProvider() {},
    async completeSimple() {
      return {
        content: [],
        stopReason: "error",
        errorMessage: "invalid token",
      };
    },
  };
  const code = await main(["--model=gpt-5.4-mini"], {
    resolveAccess: async () => "test-token",
    createCollection: () => collection,
  });
  assert.equal(code, 4);
});

test("smoke returns nonzero when the model does not reply exactly OK", async () => {
  const collection = {
    setProvider() {},
    async completeSimple() {
      return {
        content: [{ type: "text", text: "Not OK" }],
        stopReason: "stop",
      };
    },
  };
  const code = await main(["--model=gpt-5.4-mini"], {
    resolveAccess: async () => "test-token",
    createCollection: () => collection,
  });
  assert.equal(code, 4);
});

test("smoke returns nonzero for thrown API failures", async () => {
  const collection = {
    setProvider() {},
    async completeSimple() {
      throw new Error("network failed");
    },
  };
  const code = await main(["--model=gpt-5.4-mini"], {
    resolveAccess: async () => "test-token",
    createCollection: () => collection,
  });
  assert.equal(code, 4);
});
