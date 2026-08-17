import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let ProxyAgent;
try {
  ({ ProxyAgent } = require("undici"));
} catch {
  // Development checkouts may junction node_modules to DSH, which does not
  // expose undici at its root. Published installs resolve the declared direct
  // dependency above; this fallback is only for the repository link workflow.
  ({ ProxyAgent } = require("./vendor/node_modules/undici/index.js"));
}

// Version the marker so an HMR process carrying the earlier marker shape
// ({ installed: true } without shared context) receives a compatible wrapper.
const INSTALLED = Symbol.for("dsh-llm-openai.scoped-fetch-proxy-installed.v2");
const agents = new Map();
const DEFAULT_PORTS = new Map([
  ["http:", "80"],
  ["https:", "443"],
]);

function firstDefined(env, keys) {
  for (const key of keys) {
    const value = env?.[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function normalizeProxyUrl(value, source) {
  const raw = /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `http://${value}`;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (error) {
    throw new Error(`llm-openai: invalid proxy URL from ${source}: ${JSON.stringify(value)}`, { cause: error });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`llm-openai: unsupported proxy protocol from ${source}: ${parsed.protocol}`);
  }
  if (parsed.hostname.length === 0) {
    throw new Error(`llm-openai: proxy URL from ${source} has no hostname`);
  }
  return parsed.toString();
}

function wildcardMatch(hostname, pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(hostname);
}

function bypassEntryMatches(target, entry) {
  const value = entry.trim().toLowerCase();
  if (value.length === 0) return false;
  if (value === "*") return true;
  if (value === "<local>") return !target.hostname.includes(".");

  let host = value;
  let port;
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end >= 0) {
      host = value.slice(1, end);
      if (value[end + 1] === ":") port = value.slice(end + 2);
    }
  } else {
    const separator = value.lastIndexOf(":");
    if (separator > 0 && /^\d+$/.test(value.slice(separator + 1))) {
      host = value.slice(0, separator);
      port = value.slice(separator + 1);
    }
  }

  const targetPort = target.port || DEFAULT_PORTS.get(target.protocol) || "";
  if (port !== undefined && port !== targetPort) return false;
  if (host.startsWith("*.")) return target.hostname.endsWith(host.slice(1)) && target.hostname !== host.slice(2);
  if (host.startsWith(".")) return target.hostname === host.slice(1) || target.hostname.endsWith(host);
  if (host.includes("*")) return wildcardMatch(target.hostname, host);
  return target.hostname === host;
}

export function shouldBypassProxy(target, env = process.env, windowsOverride) {
  const noProxy = firstDefined(env, ["NO_PROXY", "no_proxy"]);
  if (noProxy !== undefined && noProxy.split(/[;,\s]+/).some((entry) => bypassEntryMatches(target, entry))) {
    return true;
  }
  return typeof windowsOverride === "string" &&
    windowsOverride.split(";").some((entry) => bypassEntryMatches(target, entry));
}

export function parseWindowsProxyServer(value) {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const trimmed = value.trim();
  if (!trimmed.includes("=")) return { default: trimmed };

  const result = {};
  for (const part of trimmed.split(";")) {
    const candidate = part.trim();
    if (candidate.length === 0) continue;
    const separator = candidate.indexOf("=");
    if (separator <= 0) {
      throw new Error(`llm-openai: invalid Windows ProxyServer entry: ${JSON.stringify(candidate)}`);
    }
    const protocol = candidate.slice(0, separator).trim().toLowerCase();
    const endpoint = candidate.slice(separator + 1).trim();
    if ((protocol === "http" || protocol === "https") && endpoint.length === 0) {
      throw new Error(`llm-openai: Windows ProxyServer has an empty ${protocol} route`);
    }
    if ((protocol === "http" || protocol === "https") && endpoint.length > 0) {
      result[protocol] = endpoint;
    }
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

let cachedWindowsProxy;
let cachedWindowsProxyResolved = false;

export function windowsSystemProxy() {
  if (cachedWindowsProxyResolved) return cachedWindowsProxy;
  cachedWindowsProxyResolved = true;
  let output;
  try {
    output = execFileSync(
      "reg.exe",
      ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    cachedWindowsProxy = undefined;
    return cachedWindowsProxy;
  }

  const enabled = output.match(/ProxyEnable\s+REG_DWORD\s+0x([0-9a-fA-F]+)/i);
  if (enabled === null || Number.parseInt(enabled[1], 16) === 0) {
    cachedWindowsProxy = undefined;
    return cachedWindowsProxy;
  }

  const server = output.match(/ProxyServer\s+REG_SZ\s+(.+)/i);
  if (server?.[1] === undefined) {
    throw new Error("llm-openai: Windows proxy is enabled but ProxyServer is missing");
  }
  const routes = parseWindowsProxyServer(server[1].trim());
  if (routes === undefined) {
    throw new Error("llm-openai: Windows proxy is enabled but ProxyServer is empty or invalid");
  }
  const override = output.match(/ProxyOverride\s+REG_SZ\s+(.+)/i);
  cachedWindowsProxy = {
    routes,
    override: override?.[1]?.trim(),
  };
  return cachedWindowsProxy;
}

function targetUrl(input) {
  if (input instanceof URL) return input;
  const raw = typeof input === "string" ? input : input?.url;
  if (typeof raw !== "string") return undefined;
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

export function resolveProxyUrlForTarget(input, env = process.env, windows = process.platform === "win32" ? windowsSystemProxy() : undefined) {
  const target = targetUrl(input);
  if (target === undefined || (target.protocol !== "http:" && target.protocol !== "https:")) return undefined;
  if (shouldBypassProxy(target, env, windows?.override)) return undefined;

  const pluginProxy = firstDefined(env, ["DSH_OPENAI_PROXY", "OPENAI_PROXY"]);
  if (pluginProxy !== undefined) return normalizeProxyUrl(pluginProxy, "DSH_OPENAI_PROXY/OPENAI_PROXY");

  const protocolKeys = target.protocol === "https:"
    ? ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]
    : ["HTTP_PROXY", "http_proxy"];
  const environmentProxy = firstDefined(env, [...protocolKeys, "ALL_PROXY", "all_proxy"]);
  if (environmentProxy !== undefined) return normalizeProxyUrl(environmentProxy, `${target.protocol.slice(0, -1).toUpperCase()}_PROXY/ALL_PROXY`);

  if (windows !== undefined) {
    const protocol = target.protocol.slice(0, -1);
    const route = windows.routes?.[protocol] ?? windows.routes?.default;
    if (route === undefined) {
      throw new Error(`llm-openai: Windows proxy is enabled but ProxyServer has no ${protocol} route`);
    }
    return normalizeProxyUrl(route, "Windows ProxyServer");
  }
  return undefined;
}

function dispatcherFor(proxyUrl) {
  let dispatcher = agents.get(proxyUrl);
  if (dispatcher === undefined) {
    dispatcher = new ProxyAgent({ uri: proxyUrl });
    agents.set(proxyUrl, dispatcher);
  }
  return dispatcher;
}

export function installScopedFetchProxy() {
  let installed = globalThis[INSTALLED];
  if (installed === undefined) {
    const originalFetch = globalThis.fetch;
    if (typeof originalFetch !== "function") {
      installed = {
        installed: false,
        context: new AsyncLocalStorage(),
        resolveProxy: resolveProxyUrlForTarget,
        dispatcherFor,
      };
      globalThis[INSTALLED] = installed;
      return installed;
    }

    installed = {
      installed: true,
      context: new AsyncLocalStorage(),
      resolveProxy: resolveProxyUrlForTarget,
      dispatcherFor,
    };
    globalThis.fetch = function scopedOpenAIFetch(input, init) {
      const current = globalThis[INSTALLED];
      const context = current?.context.getStore();
      if (context === undefined || init?.dispatcher !== undefined) return originalFetch(input, init);
      const proxyUrl = current.resolveProxy(input, context.env);
      if (proxyUrl === undefined) return originalFetch(input, init);
      return originalFetch(input, { ...init, dispatcher: current.dispatcherFor(proxyUrl) });
    };
    globalThis[INSTALLED] = installed;
  } else {
    // HMR can load a new module instance while the wrapper remains installed.
    installed.resolveProxy = resolveProxyUrlForTarget;
    installed.dispatcherFor = dispatcherFor;
  }
  return installed;
}

export function withOpenAIProxy(operation, env = process.env) {
  const installed = installScopedFetchProxy();
  return installed.context.run({ env }, operation);
}

export function proxyConfiguredFor(input, env = process.env) {
  return resolveProxyUrlForTarget(input, env) !== undefined;
}

export { installScopedFetchProxy as installProxy };
