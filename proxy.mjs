import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function loadUndiciProxyAgent() {
  try {
    return require("undici").ProxyAgent;
  } catch {
    // Vendored fallback: install with
    //   npm install --prefix vendor undici@6.21.2
    return require("./vendor/node_modules/undici/index.js").ProxyAgent;
  }
}

const ProxyAgent = loadUndiciProxyAgent();

const INSTALLED = Symbol.for("dsh-llm-openai.fetch-proxy-installed");
const agents = new Map();

function firstDefined(env, keys) {
  for (const key of keys) {
    const value = env?.[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

export function proxyUrlFromEnv(env = process.env) {
  return firstDefined(env, [
    "DSH_OPENAI_PROXY",
    "OPENAI_PROXY",
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "ALL_PROXY",
    "all_proxy",
  ]);
}

let cachedWindowsProxy;
let cachedWindowsProxyResolved = false;

export function windowsSystemProxyUrl() {
  if (!cachedWindowsProxyResolved) {
    cachedWindowsProxyResolved = true;
    try {
      const server = execFileSync(
        "reg.exe",
        [
          "query",
          "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
          "/v",
          "ProxyServer",
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
      const enabled = execFileSync(
        "reg.exe",
        [
          "query",
          "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
          "/v",
          "ProxyEnable",
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
      const enabledMatch = enabled.match(/ProxyEnable\s+REG_DWORD\s+0x([0-9a-fA-F]+)/i);
      const enabledValue = enabledMatch ? Number.parseInt(enabledMatch[1], 16) : 0;
      const match = server.match(/ProxyServer\s+REG_SZ\s+(.+)/i);
      if (enabledValue !== 0 && match?.[1] !== undefined) {
        const value = match[1].trim();
        if (value.length > 0) {
          cachedWindowsProxy = /^https?:\/\//i.test(value) ? value : `http://${value}`;
        }
      }
    } catch {
      cachedWindowsProxy = undefined;
    }
  }
  return cachedWindowsProxy;
}

export function resolveProxyUrl(env = process.env) {
  const fromEnv = proxyUrlFromEnv(env);
  if (fromEnv !== undefined) return fromEnv;
  if (process.platform === "win32") return windowsSystemProxyUrl();
  return undefined;
}

function dispatcherFor(protocol, proxyUrl) {
  if (protocol !== "https:" && protocol !== "http:") return undefined;
  let dispatcher = agents.get(proxyUrl);
  if (dispatcher === undefined) {
    dispatcher = new ProxyAgent({ uri: proxyUrl });
    agents.set(proxyUrl, dispatcher);
  }
  return dispatcher;
}

function inputUrl(input) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input?.url;
}

export function installGlobalFetchProxy(env = process.env) {
  const marker = globalThis[INSTALLED];
  if (marker !== undefined) return marker;

  const proxyUrl = resolveProxyUrl(env);
  const originalFetch = globalThis.fetch;
  if (typeof originalFetch !== "function") {
    const result = { proxyUrl: undefined };
    globalThis[INSTALLED] = result;
    return result;
  }

  const proxiedFetch = function (input, init) {
    if (proxyUrl === undefined) return originalFetch(input, init);
    try {
      const raw = inputUrl(input);
      if (raw !== undefined) {
        const protocol = new URL(raw).protocol;
        const dispatcher = dispatcherFor(protocol, proxyUrl);
        if (dispatcher !== undefined) {
          return originalFetch(input, { ...init, dispatcher });
        }
      }
    } catch {
      // Keep the original fetch contract for inputs that are not URLs.
    }
    return originalFetch(input, init);
  };

  globalThis.fetch = proxiedFetch;
  const result = { proxyUrl };
  globalThis[INSTALLED] = result;
  return result;
}

export { installGlobalFetchProxy as installProxy };
