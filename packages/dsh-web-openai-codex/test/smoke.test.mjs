import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../smoke-test.mjs";

test("web smoke refuses authenticated traffic unless --live is explicit", async () => {
  let calls = 0;
  const code = await main([], {
    createTransport() {
      calls += 1;
    },
    resolveAccessToken: async () => "must-not-be-read",
  });
  assert.equal(code, 2);
  assert.equal(calls, 0);
});
