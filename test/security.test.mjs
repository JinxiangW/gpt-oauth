import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createDshAdapter,
  DEFAULT_BASE_URL,
  inOpenAIProxyContext,
  trustedBaseURL,
} from "../index.js";
import {
  freshAccessFromOwnStore,
  readOAuthSource,
  saveOAuthCredentials,
} from "../oauth-store.mjs";
import {
  parseWindowsProxyServer,
  resolveProxyUrlForTarget,
} from "../proxy.mjs";
import {
  browserOpenCommand,
  deviceLogin,
  normalizeDeviceInterval,
  pollDeviceAuth,
  startCallbackServer,
} from "../login.mjs";

const execFileAsync = promisify(execFile);

test("baseURL accepts only the trusted ChatGPT subscription endpoint", () => {
  assert.equal(trustedBaseURL(DEFAULT_BASE_URL), DEFAULT_BASE_URL);
  assert.equal(trustedBaseURL(`${DEFAULT_BASE_URL}/`), DEFAULT_BASE_URL);
  for (const value of [
    "http://chatgpt.com/backend-api",
    "https://evil.example/backend-api",
    "https://chatgpt.com/backend-api/other",
    "https://chatgpt.com/backend-api?redirect=evil",
    "https://user:pass@chatgpt.com/backend-api",
  ]) {
    assert.throws(() => trustedBaseURL(value), /must be exactly|trusted ChatGPT/);
  }
});

test("proxy parsing honors protocol routes and bypass lists", () => {
  assert.deepEqual(parseWindowsProxyServer("http=proxy-a:8080;https=proxy-b:8443"), {
    http: "proxy-a:8080",
    https: "proxy-b:8443",
  });
  assert.equal(
    resolveProxyUrlForTarget("https://chatgpt.com/backend-api", {}, {
      routes: parseWindowsProxyServer("http=proxy-a:8080;https=proxy-b:8443"),
    }),
    "http://proxy-b:8443/",
  );
  assert.equal(
    resolveProxyUrlForTarget("https://chatgpt.com/backend-api", {
      HTTPS_PROXY: "proxy:9000",
      NO_PROXY: "chatgpt.com",
    }),
    undefined,
  );
  assert.equal(
    resolveProxyUrlForTarget("https://chatgpt.com/backend-api", { DSH_OPENAI_PROXY: "proxy:9000" }),
    "http://proxy:9000/",
  );
  assert.throws(
    () => resolveProxyUrlForTarget("https://chatgpt.com/backend-api", { DSH_OPENAI_PROXY: "://bad" }),
    /invalid proxy URL/,
  );
  assert.throws(
    () => parseWindowsProxyServer("http=proxy-a:8080;broken"),
    /invalid Windows ProxyServer/,
  );
  assert.throws(
    () => resolveProxyUrlForTarget("https://chatgpt.com/backend-api", {}, {
      routes: { http: "proxy-a:8080" },
    }),
    /no https route/,
  );
});

test("a malformed Windows proxy keeps failing on repeated reads", { skip: process.platform !== "win32" }, async () => {
  const proxyUrl = new URL("../proxy.mjs", import.meta.url).href;
  const script = `
    const { createRequire, syncBuiltinESMExports } = await import("node:module");
    const require = createRequire(import.meta.url);
    const childProcess = require("node:child_process");
    childProcess.execFileSync = () => "ProxyEnable REG_DWORD 0x1\\nProxyServer REG_SZ http=proxy:8080;broken";
    syncBuiltinESMExports();
    const { windowsSystemProxy } = await import(${JSON.stringify(proxyUrl)});
    for (let attempt = 0; attempt < 2; attempt++) {
      let rejected = false;
      try { windowsSystemProxy(); } catch { rejected = true; }
      if (!rejected) throw new Error("invalid proxy silently bypassed on attempt " + attempt);
    }
  `;
  await execFileAsync(process.execPath, ["--input-type=module", "--eval", script]);
});

test("device login requests have a deadline and malformed responses do not expose authorization values", async () => {
  const previousFetch = globalThis.fetch;
  try {
    let signal;
    globalThis.fetch = async (_url, init) => {
      signal = init.signal;
      return new Response(JSON.stringify({ device_auth_id: "private-device-id", user_code: "private-user-code" }));
    };
    await assert.rejects(deviceLogin({ notify() {} }), error => {
      assert.match(error.message, /Invalid OpenAI device-code response/);
      assert.ok(!error.message.includes("private-"));
      return true;
    });
    assert.ok(signal instanceof AbortSignal);
    globalThis.fetch = async () => new Response(JSON.stringify({ authorization_code: "private-auth-code", code_verifier: "" }));
    await assert.rejects(pollDeviceAuth({ deviceAuthId: "test", userCode: "test", intervalSeconds: 1 }), error => {
      assert.match(error.message, /Invalid OpenAI device-auth token response/);
      assert.ok(!error.message.includes("private-auth-code"));
      return true;
    });
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "invalid_grant", access_token: "private-access-token" }), { status: 400 });
    await assert.rejects(deviceLogin({ notify() {} }), error => {
      assert.match(error.message, /invalid_grant/);
      assert.ok(!error.message.includes("private-access-token"));
      return true;
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("fetch proxy changes behavior only inside its async context", async () => {
  const proxyUrl = new URL("../proxy.mjs", import.meta.url).href;
  const indexUrl = new URL("../index.js", import.meta.url).href;
  const script = `
    globalThis.fetch = async (_input, init) => init;
    globalThis[Symbol.for("dsh-llm-openai.scoped-fetch-proxy-installed")] = { installed: true };
    const { installScopedFetchProxy, withOpenAIProxy } = await import(${JSON.stringify(proxyUrl)});
    installScopedFetchProxy();
    const outside = await fetch("https://chatgpt.com/backend-api");
    if (outside !== undefined) throw new Error("outside context was changed");
    const inside = await withOpenAIProxy(
      () => fetch("https://chatgpt.com/backend-api"),
      { DSH_OPENAI_PROXY: "http://proxy.example:8080" },
    );
    if (inside?.dispatcher === undefined) throw new Error("context did not add dispatcher");
    const explicit = { explicit: true };
    const preserved = await withOpenAIProxy(
      () => fetch("https://chatgpt.com/backend-api", { dispatcher: explicit }),
      { DSH_OPENAI_PROXY: "http://proxy.example:8080" },
    );
    if (preserved.dispatcher !== explicit) throw new Error("explicit dispatcher was replaced");
    const reloaded = await import(${JSON.stringify(proxyUrl)} + "?hmr=1");
    reloaded.installScopedFetchProxy();
    const afterReload = await reloaded.withOpenAIProxy(
      () => fetch("https://chatgpt.com/backend-api"),
      { DSH_OPENAI_PROXY: "http://proxy.example:8080" },
    );
    if (afterReload?.dispatcher === undefined) throw new Error("reloaded module lost proxy context");
    process.env.DSH_OPENAI_PROXY = "http://proxy.example:8080";
    const { inOpenAIProxyContext } = await import(${JSON.stringify(indexUrl)});
    const events = inOpenAIProxyContext(() => ({
      async *[Symbol.asyncIterator]() {
        yield await fetch("https://chatgpt.com/backend-api/codex/responses");
      },
    }));
    const streamed = await events[Symbol.asyncIterator]().next();
    if (streamed.value?.dispatcher === undefined) throw new Error("async iterator lost proxy context");
  `;
  await execFileAsync(process.execPath, ["--input-type=module", "--eval", script]);
});

test("proxy stream wrapper does not return an already exhausted iterator", async () => {
  let returns = 0;
  const events = inOpenAIProxyContext(() => ({
    [Symbol.asyncIterator]() {
      return {
        async next() { return { done: true }; },
        async return() {
          returns += 1;
          throw new Error("return after exhaustion");
        },
      };
    },
  }));
  for await (const _event of events) assert.fail("unexpected event");
  assert.equal(returns, 0);
});

test("DSH adapter resolves the durable attachment service at request time", () => {
  const attachments = { name: "test-attachments" };
  const adapter = createDshAdapter(
    { get: (name) => name === "attachments" ? attachments : undefined },
    () => new Map(),
    async () => "token",
  );
  assert.equal(adapter.config.resolveAttachments(), attachments);
});

test("Windows browser opener passes the OAuth URL as one argument without cmd", () => {
  const url = "https://auth.openai.com/oauth/authorize?a=1&b=2&state=three";
  const command = browserOpenCommand(url, "win32");
  assert.equal(command.file, "rundll32.exe");
  assert.equal(command.args.at(-1), url);
  assert.equal(command.args.length, 2);
});

test("device polling interval is always positive", () => {
  assert.equal(normalizeDeviceInterval(0), 1);
  assert.equal(normalizeDeviceInterval("2"), 2);
  assert.equal(normalizeDeviceInterval(-1), undefined);
  assert.equal(normalizeDeviceInterval("bad"), undefined);
});

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : undefined;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

test("OAuth denial settles and callback server closes", async () => {
  const port = await freePort();
  const controller = await startCallbackServer("expected", { port, timeoutMs: 1000 });
  const response = await fetch(`http://127.0.0.1:${port}/auth/callback?state=expected&error=access_denied`);
  assert.equal(response.status, 400);
  const result = await controller.waitForCode;
  assert.match(result.error.message, /access_denied/);
  await controller.close();
  await assert.rejects(fetch(`http://127.0.0.1:${port}/auth/callback`));
});

test("OAuth callback timeout settles and closes cleanly", async () => {
  const port = await freePort();
  const controller = await startCallbackServer("expected", { port, timeoutMs: 20 });
  const result = await controller.waitForCode;
  assert.match(result.error.message, /timed out/);
  await controller.close();
});

test("installer refuses an existing real plugin directory without deleting it", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-openai-installer-"));
  const dshHome = join(root, "dsh-home");
  const profilePath = join(dshHome, "profiles", "desktop");
  const pluginPath = join(profilePath, "node_modules", "dsh-llm-openai");
  const sentinel = join(pluginPath, "keep.txt");
  try {
    await mkdir(join(dshHome, "profiles", "node_modules"), { recursive: true });
    await mkdir(pluginPath, { recursive: true });
    await writeFile(join(profilePath, "package.json"), JSON.stringify({ name: "installer-test", private: true, dsh: { profile: { bundles: [] } } }));
    await writeFile(sentinel, "keep", "utf8");
    await assert.rejects(
      execFileAsync("pwsh", [
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", fileURLToPath(new URL("../link-to-dsh.ps1", import.meta.url)),
        "-Profile", "desktop", "-AllowRunningApp",
      ], {
        env: { ...process.env, DSH_HOME: dshHome, APPDATA: join(root, "appdata") },
      }),
      error => /refusing to replace/.test(error.stderr),
    );
    assert.equal(await readFile(sentinel, "utf8"), "keep");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the checkout installer resolves the Web package's LLM peer and is repeatable", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-openai-peer-installer-"));
  const checkout = join(root, "checkout");
  const webPackage = join(checkout, "packages", "dsh-web-openai-codex");
  const dshHome = join(root, "dsh-home");
  const profilePath = join(dshHome, "profiles", "desktop");
  try {
    await mkdir(webPackage, { recursive: true });
    await mkdir(profilePath, { recursive: true });
    await copyFile(new URL("../link-to-dsh.ps1", import.meta.url), join(checkout, "link-to-dsh.ps1"));
    await writeFile(join(checkout, "package.json"), JSON.stringify({ name: "dsh-llm-openai", version: "0.4.0", type: "module", exports: { "./boot-log": "./boot-log.mjs" } }));
    await writeFile(join(checkout, "boot-log.mjs"), "export const value = 'resolved-local-peer';\n");
    await writeFile(join(webPackage, "package.json"), JSON.stringify({ name: "dsh-web-openai-codex", type: "module" }));
    await writeFile(join(webPackage, "probe.mjs"), "export { value } from 'dsh-llm-openai/boot-log';\n");
    await writeFile(join(profilePath, "package.json"), JSON.stringify({ name: "installer-test", private: true, dsh: { profile: { bundles: [] } } }));
    const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(checkout, "link-to-dsh.ps1"), "-Profile", "desktop", "-AllowRunningApp"];
    const options = { env: { ...process.env, DSH_HOME: dshHome, APPDATA: join(root, "appdata"), LOCALAPPDATA: join(root, "localappdata") } };
    await execFileAsync("pwsh", args, options);
    const resolved = await import(pathToFileURL(join(webPackage, "probe.mjs")).href);
    assert.equal(resolved.value, "resolved-local-peer");
    const repeated = await execFileAsync("pwsh", args, options);
    assert.match(repeated.stdout, /Web plugin LLM peer link already ok/);
    const manifest = JSON.parse(await readFile(join(profilePath, "package.json"), "utf8"));
    assert.deepEqual(manifest.dsh.profile.bundles, ["dsh-llm-openai", "dsh-web-openai-codex"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OAuth store writes complete JSON and refresh re-reads under lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-openai-oauth-"));
  const path = join(root, "openai-oauth.json");
  try {
    const initial = { type: "oauth", access: "old-access", refresh: "old-refresh", expires: 1 };
    await saveOAuthCredentials(path, initial);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), initial);

    let refreshCalls = 0;
    const refresh = async (refreshToken) => {
      refreshCalls += 1;
      assert.equal(refreshToken, "old-refresh");
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
      return { access: "new-access", refresh: "new-refresh", expires: Date.now() + 60_000 };
    };
    const [firstAccess, secondAccess] = await Promise.all([
      freshAccessFromOwnStore(path, refresh, 1000),
      freshAccessFromOwnStore(path, refresh, 1000),
    ]);
    assert.equal(firstAccess, "new-access");
    assert.equal(secondAccess, "new-access");
    assert.equal(refreshCalls, 1);
    assert.equal((await readOAuthSource(path)).credential.refresh, "new-refresh");

    await writeFile(path, "{broken", "utf8");
    await assert.rejects(readOAuthSource(path), /JSON/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
