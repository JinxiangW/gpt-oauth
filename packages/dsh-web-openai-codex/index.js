import { CODEX_SEARCH_DEFAULTS, CodexSearchProvider } from "./lib/codex-search.js";
import {
  DEFAULT_SAFE_HTTP_LIMITS,
  createSafeHttpFetchProvider,
} from "./lib/safe-http-fetch.js";
import { installAgentWebTools } from "./lib/tool-registration.js";

const name = "web-openai-codex";
const inject = ["agents", "tools", "systemPrompt"];
const FAILED_DISPOSAL_FINGERPRINT = Symbol("failed Codex Web disposal");
const WEB_OPTION_CEILINGS = Object.freeze({
  searchMaxResults: 50,
  searchTimeoutMs: 120_000,
  searchMaxOutputTokens: 16_384,
  assistantContextTokens: 4_000,
  fetchTimeoutMs: 120_000,
  fetchMaxResponseBytes: 20 * 1024 * 1024,
  fetchMaxBodyChars: 1_000_000,
  fetchMaxRedirects: 10,
  fetchMaxUrlLength: 8_192,
  fetchMaxOutputChars: 1_000_000,
});
const DISABLED_WEB_OPTIONS = Object.freeze({
  enabled: false,
  searchMaxResults: 8,
  searchTimeoutMs: 60_000,
  searchMaxOutputTokens: CODEX_SEARCH_DEFAULTS.searchMaxOutputTokens,
  assistantContextTokens: CODEX_SEARCH_DEFAULTS.assistantContextTokens,
  fetchTimeoutMs: DEFAULT_SAFE_HTTP_LIMITS.timeoutMs,
  fetchMaxResponseBytes: DEFAULT_SAFE_HTTP_LIMITS.maxBytes,
  fetchMaxBodyChars: DEFAULT_SAFE_HTTP_LIMITS.maxBodyChars,
  fetchMaxRedirects: DEFAULT_SAFE_HTTP_LIMITS.maxRedirects,
  fetchMaxUrlLength: 2048,
  fetchMaxOutputChars: 200_000,
});

function boundedInteger(label, value, allowZero = false) {
  const minimum = allowZero ? 0 : 1;
  const maximum = WEB_OPTION_CEILINGS[label];
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`web-openai-codex: ${label} must be a safe integer from ${minimum} to ${maximum}`);
  }
  return value;
}

export function resolveWebOptions(raw) {
  const value = { ...DISABLED_WEB_OPTIONS, ...(raw ?? {}) };
  if (typeof value.enabled !== "boolean") throw new Error("web-openai-codex: enabled must be boolean");
  return Object.freeze({
    enabled: value.enabled,
    searchMaxResults: boundedInteger("searchMaxResults", value.searchMaxResults),
    searchTimeoutMs: boundedInteger("searchTimeoutMs", value.searchTimeoutMs),
    searchMaxOutputTokens: boundedInteger("searchMaxOutputTokens", value.searchMaxOutputTokens),
    assistantContextTokens: boundedInteger("assistantContextTokens", value.assistantContextTokens),
    fetchTimeoutMs: boundedInteger("fetchTimeoutMs", value.fetchTimeoutMs),
    fetchMaxResponseBytes: boundedInteger("fetchMaxResponseBytes", value.fetchMaxResponseBytes),
    fetchMaxBodyChars: boundedInteger("fetchMaxBodyChars", value.fetchMaxBodyChars),
    fetchMaxRedirects: boundedInteger("fetchMaxRedirects", value.fetchMaxRedirects, true),
    fetchMaxUrlLength: boundedInteger("fetchMaxUrlLength", value.fetchMaxUrlLength),
    fetchMaxOutputChars: boundedInteger("fetchMaxOutputChars", value.fetchMaxOutputChars),
  });
}

function safeDispose(dispose, logger, label) {
  try {
    dispose?.();
    return true;
  } catch (error) {
    logger.warn?.(`web-openai-codex: failed to dispose ${label}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

export function createAgentWebToggle({ agents, searchProvider, makeFetchProvider, options, logger = console }) {
  const installed = new Map();

  function resolved() {
    return resolveWebOptions(options());
  }

  function install(agent, config, fingerprint) {
    const fetchProvider = makeFetchProvider(config);
    const dispose = installAgentWebTools(agent, searchProvider, fetchProvider, config);
    installed.set(agent, { dispose, fingerprint });
  }

  function reconcile(agent) {
    const config = resolved();
    const desiredFingerprint = config.enabled ? JSON.stringify(config) : undefined;
    const current = installed.get(agent);
    if (current?.fingerprint === desiredFingerprint) return;
    if (agent.status !== "idle") return;
    if (current !== undefined) {
      if (!safeDispose(current.dispose, logger, `Codex web tools for agent ${agent.id}`)) {
        current.fingerprint = FAILED_DISPOSAL_FINGERPRINT;
        return;
      }
      installed.delete(agent);
    }
    if (!config.enabled) return;
    try {
      install(agent, config, desiredFingerprint);
    } catch (error) {
      logger.error?.(`web-openai-codex: failed to install tools for agent ${agent.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function reconcileAll() {
    for (const agent of agents.list()) reconcile(agent);
  }

  function forget(agent) {
    const registration = installed.get(agent);
    if (registration === undefined) return;
    if (safeDispose(registration.dispose, logger, `Codex web tools for disposed agent ${agent.id}`)) {
      installed.delete(agent);
    } else {
      registration.fingerprint = FAILED_DISPOSAL_FINGERPRINT;
    }
  }

  function disposeAll() {
    for (const [agent, registration] of [...installed]) {
      if (safeDispose(registration.dispose, logger, `Codex web tools for agent ${agent.id}`)) {
        installed.delete(agent);
      } else {
        registration.fingerprint = FAILED_DISPOSAL_FINGERPRINT;
      }
    }
  }

  return { reconcile, reconcileAll, forget, disposeAll, installed };
}

function apply(ctx) {
  const currentOptions = () => {
    const service = ctx.get("openaiCodexWebSettings");
    return resolveWebOptions(service?.get?.() ?? DISABLED_WEB_OPTIONS);
  };
  const searchProvider = new CodexSearchProvider({
    transport: {
      request(request) {
        const transport = ctx.get("openaiCodexTransport");
        if (transport === undefined || typeof transport.request !== "function") {
          const error = new Error("web-openai-codex: dsh-llm-openai Codex transport is unavailable");
          error.code = "MISSING_CREDENTIAL_TRANSPORT";
          throw error;
        }
        return transport.request(request);
      },
    },
    resolveOptions: currentOptions,
  });
  const makeFetchProvider = (options) => createSafeHttpFetchProvider({
    limits: {
      maxUrlLength: options.fetchMaxUrlLength,
      timeoutMs: options.fetchTimeoutMs,
      maxRedirects: options.fetchMaxRedirects,
      maxBytes: options.fetchMaxResponseBytes,
      maxBodyChars: options.fetchMaxBodyChars,
    },
  });
  const toggle = createAgentWebToggle({
    agents: ctx.agents,
    searchProvider,
    makeFetchProvider,
    options: currentOptions,
    logger: ctx.logger,
  });

  ctx.on("agent/created", ({ agent }) => toggle.reconcile(agent));
  ctx.on("agent/status", ({ agent, status }) => {
    if (status === "idle") toggle.reconcile(agent);
  });
  ctx.on("agent/disposed", ({ agent }) => toggle.forget(agent));
  ctx.effect(() => () => toggle.disposeAll());

  ctx.inject(["openaiCodexWebSettings"], (injectedCtx) => {
    const service = injectedCtx.get("openaiCodexWebSettings");
    const unsubscribe = service?.subscribe?.(() => toggle.reconcileAll());
    toggle.reconcileAll();
    injectedCtx.effect(() => () => {
      unsubscribe?.();
      // The core service and OAuth transport share one owner. Remove the scoped
      // tools immediately if that owner unloads instead of leaving stale tools.
      toggle.disposeAll();
    });
  });

  toggle.reconcileAll();
}

export {
  CODEX_SEARCH_DEFAULTS,
  CodexSearchProvider,
  DEFAULT_SAFE_HTTP_LIMITS,
  DISABLED_WEB_OPTIONS,
  apply,
  createSafeHttpFetchProvider,
  inject,
  installAgentWebTools,
  name,
};
