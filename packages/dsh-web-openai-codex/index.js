import z from "@deepseek-ai/schemastery";
import { bootLog, bootLogStart } from "dsh-llm-openai/boot-log";
import { CODEX_SEARCH_DEFAULTS, CodexSearchProvider } from "./lib/codex-search.js";
import { createAgentWebToggle } from "./lib/legacy-agent-toggle.js";
import {
  DEFAULT_SAFE_HTTP_LIMITS,
  SAFE_HTTP_FETCH_PROVIDER_ID,
  createSafeHttpFetchProvider,
} from "./lib/safe-http-fetch.js";

const name = "web-openai-codex";
const inject = ["web"];
const SEARCH_PROVIDER_ID = "openai-codex";
const WEB_OPTION_CEILINGS = Object.freeze({
  searchMaxOutputTokens: 16_384,
  assistantContextTokens: 4_000,
  searchModelChars: 200,
});

const Config = z.object({
  searchMaxOutputTokens: z.number().min(1).max(WEB_OPTION_CEILINGS.searchMaxOutputTokens).default(CODEX_SEARCH_DEFAULTS.searchMaxOutputTokens),
  assistantContextTokens: z.number().min(1).max(WEB_OPTION_CEILINGS.assistantContextTokens).default(CODEX_SEARCH_DEFAULTS.assistantContextTokens),
  searchModel: z.string().default(CODEX_SEARCH_DEFAULTS.searchModel),
});

function boundedInteger(label, value) {
  const maximum = WEB_OPTION_CEILINGS[label];
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`web-openai-codex: ${label} must be a safe integer from 1 to ${maximum}`);
  }
  return value;
}

function boundedSearchModel(value) {
  const model = typeof value === "string" ? value.trim() : "";
  if (model.length === 0) {
    throw new Error("web-openai-codex: searchModel must be a non-empty GPT wire model id used when the session model is not openai-codex");
  }
  if (model.length > WEB_OPTION_CEILINGS.searchModelChars) {
    throw new Error(`web-openai-codex: searchModel must be at most ${WEB_OPTION_CEILINGS.searchModelChars} characters`);
  }
  return model;
}

export function resolveWebOptions(raw) {
  const value = Config(raw ?? {});
  return Object.freeze({
    searchMaxOutputTokens: boundedInteger("searchMaxOutputTokens", value.searchMaxOutputTokens),
    assistantContextTokens: boundedInteger("assistantContextTokens", value.assistantContextTokens),
    searchModel: boundedSearchModel(value.searchModel),
  });
}

function transportFrom(ctx) {
  const transport = ctx.get("openaiCodexTransport");
  if (transport === undefined) {
    const error = new Error("web-openai-codex: dsh-llm-openai is not loaded, so the Codex OAuth transport is unavailable");
    error.code = "MISSING_CREDENTIAL";
    throw error;
  }
  return transport;
}

export function createCodexWebSearchProvider(ctx, options) {
  const provider = new CodexSearchProvider({
    transport: {
      request(input) {
        return transportFrom(ctx).request(input);
      },
    },
    resolveOptions: options,
    // `ctx.agents` is guarded by cordis: reading a service off the context
    // without declaring it in `inject` throws "cannot get property ... without
    // inject". This root-level plugin declares only `web`, and adding `agents`
    // would gate its activation on an unrelated service, so the service is read
    // through `ctx.get()`. The agents service backs `currentInitiator()` with an
    // AsyncLocalStorage, so a call made while a tool executes still resolves the
    // initiating agent; outside that boundary it resolves to undefined.
    resolveAgent: () => ctx.get("agents")?.currentInitiator(),
  });
  provider.id = SEARCH_PROVIDER_ID;
  return provider;
}

export function apply(ctx, config) {
  bootLogStart("web-openai-codex");
  bootLog("web-openai-codex", `entry: ${import.meta.url}`);
  // DSH 0.2 resolves this Loader entry's config row before apply(), so the
  // options are read once here and the provider closes over that snapshot; a
  // changed row remounts the plugin.
  const options = () => resolveWebOptions(config);
  const resolved = options();
  bootLog("web-openai-codex", `options ok (searchModel=${resolved.searchModel})`);
  ctx.web.registerSearchProvider(createCodexWebSearchProvider(ctx, options));
  bootLog("web-openai-codex", "search provider registered");
}

export {
  CODEX_SEARCH_DEFAULTS,
  Config,
  CodexSearchProvider,
  DEFAULT_SAFE_HTTP_LIMITS,
  SAFE_HTTP_FETCH_PROVIDER_ID,
  SEARCH_PROVIDER_ID,
  createAgentWebToggle,
  createSafeHttpFetchProvider,
  inject,
  name,
};
