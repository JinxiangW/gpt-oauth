import { homedir } from "node:os";
import { join } from "node:path";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { buildBaseOptions } from "@earendil-works/pi-ai/api/simple-options";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import {
  LlmError,
  RetryPolicySchema,
  assertUsableApiKey,
  attributionHeaders,
  resolveRetryPolicy,
} from "@deepseek-ai/dsh-llm";
import {
  deepEqualJson,
  installSettingsSection,
  settingsNamespace,
} from "@deepseek-ai/dsh-settings";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { MAX_TIMER_DELAY_MS } from "@deepseek-ai/dsh-timeout";
import z from "@deepseek-ai/schemastery";
import { freshAccessFromOwnStore, readOAuthSource } from "./oauth-store.mjs";
import {
  installScopedFetchProxy,
  proxyConfiguredFor,
  withOpenAIProxy,
} from "./proxy.mjs";

// The compatibility shim is process-global because pi-ai calls global fetch,
// but it changes behavior only inside withOpenAIProxy()'s async context.
installScopedFetchProxy();

const name = "llm-openai";
const inject = ["llm"];

const PROVIDER = "openai-codex";
const DISPLAY_NAME = "OpenAI (ChatGPT)";
const NS = settingsNamespace("llm-openai");

const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api";
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300000;
const CHATGPT_AUTH_CLAIM = "https://api.openai.com/auth";
const CODEX_TRANSPORT_SERVICE = "openaiCodexTransport";
const ALLOWED_CODEX_PATHS = new Set(["alpha/search"]);

// Same OAuth application/endpoints used by opencode and pi-ai's bundled
// openai-codex flow. ChatGPT-subscription tokens are not regular platform API
// keys: opencode rewrites /v1/responses requests to the ChatGPT Codex backend
// and adds chatgpt-account-id, so this adapter uses pi-ai's openai-codex
// provider (https://chatgpt.com/backend-api/codex/responses) for the same
// behavior.
const AUTH_BASE_URL = "https://auth.openai.com";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`;
const TOKEN_REFRESH_SKEW_MS = 60_000;

// opencode's model catalog ships "-fast" siblings for these ChatGPT models:
// same wire model id, plus `service_tier: "priority"` on the request.
const FAST_SUFFIX = "-fast";
const FAST_SERVICE_TIER = "priority";
const FAST_MODEL_IDS = new Set([
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.5",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
]);

const CODEX_WEB_CEILINGS = Object.freeze({
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

const CodexWebConfig = z.object({
  enabled: z.boolean().default(false).description("Codex Web 总开关：开启后 web_search 使用 ChatGPT OAuth 配额并同时提供安全 web_fetch；关闭后恢复 DSH 默认搜索。"),
  searchMaxResults: z.number().min(1).max(CODEX_WEB_CEILINGS.searchMaxResults).default(8).description("每次搜索最多返回的结构化来源数。"),
  searchTimeoutMs: z.number().min(1).max(CODEX_WEB_CEILINGS.searchTimeoutMs).default(60_000).description("web_search 工具超时（毫秒）。"),
  searchMaxOutputTokens: z.number().min(1).max(CODEX_WEB_CEILINGS.searchMaxOutputTokens).default(4096).description("Codex 搜索接口的最大输出 token 预算。"),
  assistantContextTokens: z.number().min(1).max(CODEX_WEB_CEILINGS.assistantContextTokens).default(1000).description("发送给 Codex 搜索的近期助手文本预算。"),
  fetchTimeoutMs: z.number().min(1).max(CODEX_WEB_CEILINGS.fetchTimeoutMs).default(60_000).description("安全 web_fetch 超时（毫秒）。"),
  fetchMaxResponseBytes: z.number().min(1).max(CODEX_WEB_CEILINGS.fetchMaxResponseBytes).default(5 * 1024 * 1024).description("安全 Fetch 最大响应字节数。"),
  fetchMaxBodyChars: z.number().min(1).max(CODEX_WEB_CEILINGS.fetchMaxBodyChars).default(100_000).description("返回给工具层的最大正文字符数。"),
  fetchMaxRedirects: z.number().min(0).max(CODEX_WEB_CEILINGS.fetchMaxRedirects).default(5).description("逐跳安全校验下允许的最大重定向次数。"),
  fetchMaxUrlLength: z.number().min(1).max(CODEX_WEB_CEILINGS.fetchMaxUrlLength).default(2048).description("允许的最大 URL 长度。"),
  fetchMaxOutputChars: z.number().min(1).max(CODEX_WEB_CEILINGS.fetchMaxOutputChars).default(200_000).description("渲染给模型的 web_fetch 最大字符数。"),
}).description("Codex Web Search + SSRF-safe HTTP Fetch");

const Config = z.object({
  baseURL: z.string().default(DEFAULT_BASE_URL),
  streamIdleTimeoutMs: z
    .number()
    .min(Number.MIN_VALUE)
    .max(MAX_TIMER_DELAY_MS)
    .default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
  codexWeb: CodexWebConfig.default({}),
});

function trustedBaseURL(value = DEFAULT_BASE_URL) {
  let url;
  try {
    url = new URL(value.trim());
  } catch (error) {
    throw new Error("llm-openai: baseURL must be the trusted ChatGPT subscription endpoint", { cause: error });
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "chatgpt.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.pathname.replace(/\/+$/, "") !== "/backend-api"
  ) {
    throw new Error(`llm-openai: baseURL must be exactly ${DEFAULT_BASE_URL} (a custom endpoint could receive the OAuth token and conversation)`);
  }
  return DEFAULT_BASE_URL;
}

function resolveAdapterOptions(config) {
  const baseURL = trustedBaseURL(config.baseURL ?? DEFAULT_BASE_URL);
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0 || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`llm-openai: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
  }
  return {
    baseURL: baseURL.replace(/\/+$/, ""),
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, "llm-openai: retryPolicy"),
  };
}

function safeIntegerSetting(name, value, minimum = 1) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`llm-openai: codexWeb.${name} must be a safe integer >= ${minimum}`);
  }
  return value;
}

function resolveCodexWebOptions(raw = {}) {
  const value = CodexWebConfig(raw);
  return Object.freeze({
    enabled: value.enabled,
    searchMaxResults: safeIntegerSetting("searchMaxResults", value.searchMaxResults),
    searchTimeoutMs: safeIntegerSetting("searchTimeoutMs", value.searchTimeoutMs),
    searchMaxOutputTokens: safeIntegerSetting("searchMaxOutputTokens", value.searchMaxOutputTokens),
    assistantContextTokens: safeIntegerSetting("assistantContextTokens", value.assistantContextTokens),
    fetchTimeoutMs: safeIntegerSetting("fetchTimeoutMs", value.fetchTimeoutMs),
    fetchMaxResponseBytes: safeIntegerSetting("fetchMaxResponseBytes", value.fetchMaxResponseBytes),
    fetchMaxBodyChars: safeIntegerSetting("fetchMaxBodyChars", value.fetchMaxBodyChars),
    fetchMaxRedirects: safeIntegerSetting("fetchMaxRedirects", value.fetchMaxRedirects, 0),
    fetchMaxUrlLength: safeIntegerSetting("fetchMaxUrlLength", value.fetchMaxUrlLength),
    fetchMaxOutputChars: safeIntegerSetting("fetchMaxOutputChars", value.fetchMaxOutputChars),
  });
}

function alignSubscriptionThinking(model) {
  const efforts = {
    off: "none",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
  };
  if (model.id.startsWith("gpt-5.6-")) efforts.max = "max";
  return {
    ...model,
    reasoning: true,
    thinkingLevelMap: Object.fromEntries(
      ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => [
        level,
        efforts[level] ?? null,
      ]),
    ),
  };
}

function fastVariant(model) {
  return {
    ...model,
    id: `${model.id}${FAST_SUFFIX}`,
    name: `${model.name} Fast`,
  };
}

function gptModelCatalog(baseURL = DEFAULT_BASE_URL) {
  const trusted = trustedBaseURL(baseURL);
  const models = openaiCodexProvider()
    .getModels()
    .filter((model) => typeof model.id === "string" && model.id.startsWith("gpt-"))
    .map((model) =>
      alignSubscriptionThinking({
        ...model,
        baseUrl: trusted,
      }),
    );
  if (models.length === 0) {
    throw new Error("llm-openai: installed pi-ai catalog contains no gpt-* models");
  }
  return models.flatMap((model) =>
    FAST_MODEL_IDS.has(model.id) ? [model, fastVariant(model)] : [model],
  );
}

function harnessApiKeyAuth(displayName) {
  return {
    name: displayName,
    resolve: ({ credential }) =>
      Promise.resolve({
        auth: credential?.key === undefined ? {} : { apiKey: credential.key },
        source: displayName,
      }),
  };
}

// A "-fast" catalog entry maps back to its base wire model and adds
// service_tier: "priority" to the Codex request (same behavior as opencode's
// model options). pi-ai's streamSimple drops unknown options, so the fast path
// builds its base options explicitly and calls stream() directly. The emitted
// message.model is then relabeled with the selector id, otherwise the harness
// replay state records the wire id and a follow-up turn fails with
// "model does not match assistant source".
function codexWireModel(model) {
  if (typeof model?.id !== "string" || !model.id.endsWith(FAST_SUFFIX)) {
    return { model };
  }
  return {
    model: { ...model, id: model.id.slice(0, -FAST_SUFFIX.length) },
    serviceTier: FAST_SERVICE_TIER,
  };
}

async function* relabelFastModel(events, selectedModel) {
  const wireId = selectedModel.id.slice(0, -FAST_SUFFIX.length);
  for await (const event of events) {
    if (event.type === "done" && event.message?.model === wireId) {
      yield { ...event, message: { ...event.message, model: selectedModel.id } };
    } else if (event.type === "error" && event.error?.model === wireId) {
      yield { ...event, error: { ...event.error, model: selectedModel.id } };
    } else {
      yield event;
    }
  }
}

function proxiedCodexOptions(options) {
  return proxyConfiguredFor(`${DEFAULT_BASE_URL}/codex/responses`)
    ? { ...options, transport: "sse" }
    : options;
}

async function* inOpenAIProxyContext(createEvents) {
  const iterator = await withOpenAIProxy(() => createEvents()[Symbol.asyncIterator]());
  let exhausted = false;
  try {
    while (true) {
      const next = await withOpenAIProxy(() => iterator.next());
      if (next.done) {
        exhausted = true;
        return;
      }
      yield next.value;
    }
  } finally {
    if (!exhausted && typeof iterator.return === "function") {
      await withOpenAIProxy(() => iterator.return());
    }
  }
}

function codexStream(baseProvider, model, context, options) {
  const wire = codexWireModel(model);
  let events = inOpenAIProxyContext(() =>
    baseProvider.stream(
      wire.model,
      context,
      proxiedCodexOptions(
        wire.serviceTier === undefined ? options : { ...options, serviceTier: wire.serviceTier },
      ),
    ),
  );
  if (wire.serviceTier !== undefined) events = relabelFastModel(events, model);
  return events;
}

function codexStreamSimple(baseProvider, model, context, options) {
  const wire = codexWireModel(model);
  let events;
  if (wire.serviceTier === undefined) {
    events = inOpenAIProxyContext(() =>
      baseProvider.streamSimple(model, context, proxiedCodexOptions(options)),
    );
  } else {
    const base = buildBaseOptions(wire.model, context, options, options?.apiKey);
    const clampedReasoning =
      options?.reasoning === undefined ? undefined : clampThinkingLevel(wire.model, options.reasoning);
    const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;
    events = inOpenAIProxyContext(() =>
      baseProvider.stream(wire.model, context, proxiedCodexOptions({
        ...base,
        reasoningEffort,
        serviceTier: wire.serviceTier,
      })),
    );
    events = relabelFastModel(events, model);
  }
  return events;
}

function buildPiProvider(baseProvider, connection) {
  const models = gptModelCatalog(connection.baseURL);
  return {
    id: PROVIDER,
    name: DISPLAY_NAME,
    baseUrl: connection.baseURL,
    auth: { apiKey: harnessApiKeyAuth(DISPLAY_NAME) },
    getModels: () => models,
    stream: (model, context, options) => codexStream(baseProvider, model, context, options),
    streamSimple: (model, context, options) => codexStreamSimple(baseProvider, model, context, options),
  };
}

function buildProfile(baseProvider, connection) {
  const models = gptModelCatalog(connection.baseURL);
  return {
    provider: PROVIDER,
    displayName: DISPLAY_NAME,
    streamIdleTimeoutMs: connection.streamIdleTimeoutMs,
    retryPolicy: connection.retryPolicy,
    headers: {},
    configuredMaxTokens: new Map(models.map((model) => [model.id, model.maxTokens])),
    piProvider: buildPiProvider(baseProvider, connection),
  };
}

// ── OAuth token store / opencode fallback ───────────────────────────────────

function ownOAuthPath() {
  return dshHomePath("openai-oauth.json");
}

function openCodeAuthCandidates() {
  const candidates = [];
  if (typeof process.env.OPENCODE_AUTH_FILE === "string" && process.env.OPENCODE_AUTH_FILE.length > 0) {
    candidates.push(process.env.OPENCODE_AUTH_FILE);
  }
  candidates.push(join(homedir(), ".local", "share", "opencode", "auth.json"));
  candidates.push(join(homedir(), ".config", "opencode", "auth.json"));
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (appData !== undefined) candidates.push(join(appData, "opencode", "auth.json"));
  }
  return candidates;
}

async function refreshOAuthToken(refreshToken) {
  let response;
  try {
    response = await withOpenAIProxy(() => fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }),
    }));
  } catch (error) {
    throw new Error(`OpenAI subscription token refresh request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`OpenAI subscription token refresh failed (HTTP ${response.status}): ${body.slice(0, 300)}`);
  }
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error(`OpenAI subscription token refresh returned invalid JSON`, { cause: error });
  }
  if (typeof payload?.access_token !== "string" || payload.access_token.length === 0) {
    throw new Error("OpenAI subscription token refresh response did not include an access_token");
  }
  if (typeof payload?.expires_in !== "number" || !Number.isFinite(payload.expires_in) || payload.expires_in <= 0) {
    throw new Error("OpenAI subscription token refresh response did not include a valid expires_in");
  }
  return {
    access: payload.access_token,
    refresh: typeof payload.refresh_token === "string" && payload.refresh_token.length > 0 ? payload.refresh_token : refreshToken,
    expires: Date.now() + payload.expires_in * 1000,
  };
}

const refreshFlights = new Map();

async function freshOwnAccess(path) {
  let flight = refreshFlights.get(path);
  if (flight === undefined) {
    flight = freshAccessFromOwnStore(path, refreshOAuthToken, TOKEN_REFRESH_SKEW_MS)
      .finally(() => refreshFlights.delete(path));
    refreshFlights.set(path, flight);
  }
  return flight;
}

async function resolveOAuthAccessToken(logger = console) {
  const ownPath = ownOAuthPath();
  let ownSource;
  try {
    ownSource = await readOAuthSource(ownPath);
  } catch (error) {
    throw new Error(`llm-openai: cannot read the selected OpenAI OAuth store ${ownPath}`, { cause: error });
  }
  if (ownSource !== undefined) return freshOwnAccess(ownPath);

  for (const path of openCodeAuthCandidates()) {
    let source;
    try {
      source = await readOAuthSource(path);
    } catch (error) {
      throw new Error(`llm-openai: cannot read the selected opencode OAuth store ${path}`, { cause: error });
    }
    if (source === undefined) continue;
    if (source.credential.expires <= Date.now() + TOKEN_REFRESH_SKEW_MS) {
      throw new Error(`llm-openai: opencode OAuth credential ${path} is expired or about to expire; run dsh-openai-login so this plugin can refresh its own credential safely`);
    }
    logger.debug?.(`llm-openai: using read-only opencode OAuth credential from ${path}`);
    return source.credential.access;
  }
  return undefined;
}

function extractChatGptAccountId(accessToken) {
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new Error("llm-openai: the ChatGPT OAuth access token is empty");
  }
  let payload;
  try {
    const parts = accessToken.split(".");
    if (parts.length !== 3) throw new Error("not a JWT");
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch (error) {
    throw new Error("llm-openai: failed to decode the ChatGPT OAuth access token", { cause: error });
  }
  const accountId = payload?.[CHATGPT_AUTH_CLAIM]?.chatgpt_account_id;
  if (typeof accountId !== "string" || accountId.length === 0) {
    throw new Error("llm-openai: the ChatGPT OAuth access token has no chatgpt_account_id claim");
  }
  return accountId;
}

function validateCodexTransportRequest(request) {
  if (typeof request !== "object" || request === null) {
    throw new Error("llm-openai: Codex transport request must be an object");
  }
  const method = request.method ?? "POST";
  if (method !== "POST") throw new Error("llm-openai: Codex transport only permits POST requests");
  if (!ALLOWED_CODEX_PATHS.has(request.path)) {
    throw new Error(`llm-openai: Codex transport path is not allowed: ${String(request.path)}`);
  }
  if (request.body === undefined) throw new Error("llm-openai: Codex transport request body is required");
  return { method, path: request.path, body: request.body, signal: request.signal };
}

function createOpenAiCodexTransport({ resolveAccessToken, logger = console, fetcher = globalThis.fetch } = {}) {
  if (typeof resolveAccessToken !== "function") {
    throw new Error("llm-openai: Codex transport requires an OAuth token resolver");
  }
  if (typeof fetcher !== "function") throw new Error("llm-openai: Codex transport requires fetch");

  return Object.freeze({
    async request(input) {
      const request = validateCodexTransportRequest(input);
      const accessToken = await resolveAccessToken(logger);
      if (accessToken === undefined) {
        const error = new Error("llm-openai: no ChatGPT subscription credential is available; run dsh-openai-login to sign in");
        error.code = "MISSING_CREDENTIAL";
        throw error;
      }
      const accountId = extractChatGptAccountId(accessToken);
      const endpoint = `${DEFAULT_BASE_URL}/codex/${request.path}`;
      try {
        return await withOpenAIProxy(() => fetcher(endpoint, {
          method: request.method,
          redirect: "error",
          signal: request.signal,
          headers: {
            authorization: `Bearer ${accessToken}`,
            "chatgpt-account-id": accountId,
            originator: "dsh",
            "content-type": "application/json",
            accept: "application/json",
            ...attributionHeaders(),
          },
          body: JSON.stringify(request.body),
        }));
      } catch (error) {
        if (request.signal?.aborted) {
          const aborted = new Error("llm-openai: Codex transport request was aborted", { cause: error });
          aborted.code = "ABORTED";
          throw aborted;
        }
        const transport = new Error(`llm-openai: Codex transport request failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        transport.code = "TRANSPORT";
        throw transport;
      }
    },
  });
}

function createDshAdapter(ctx, profiles, resolveApiKey) {
  return new PiAiAdapter({
    profiles,
    resolveApiKey,
    resolveAttachments: () => ctx.get("attachments"),
  });
}

function apply(ctx, config) {
  let current = () => config;
  let lastRaw;
  let lastGood;

  const options = () => {
    const raw = current();
    if (raw === lastRaw && lastGood !== undefined) return lastGood;
    try {
      const next = resolveAdapterOptions(raw);
      lastRaw = raw;
      lastGood = next;
      return next;
    } catch (error) {
      if (lastGood === undefined) throw error;
      lastRaw = raw;
      ctx.logger.error("llm-openai: keeping the last good configuration after an invalid settings section");
      ctx.logger.error(error);
      return lastGood;
    }
  };
  const webOptions = () => resolveCodexWebOptions(current()?.codexWeb);
  options();
  webOptions();

  const baseProvider = openaiCodexProvider();
  let profileCache;
  const profiles = () => {
    const connection = options();
    if (profileCache?.connection === connection) return profileCache.profiles;
    const next = new Map([[PROVIDER, buildProfile(baseProvider, connection)]]);
    profileCache = { connection, profiles: next };
    return next;
  };

  const resolveApiKey = async () => {
    const oauthAccess = await resolveOAuthAccessToken(ctx.logger);
    if (oauthAccess !== undefined) {
      return assertUsableApiKey(oauthAccess, "llm-openai", "OpenAI subscription OAuth");
    }
    throw new LlmError(
      "llm-openai: no ChatGPT subscription credential is available; run dsh-openai-login to sign in",
      "MISSING_CREDENTIAL",
    );
  };

  const codexTransport = createOpenAiCodexTransport({
    resolveAccessToken: resolveOAuthAccessToken,
    logger: ctx.logger,
  });
  const webSettingsListeners = new Set();
  const notifyWebSettings = () => {
    for (const listener of [...webSettingsListeners]) {
      try {
        listener(webOptions());
      } catch (error) {
        ctx.logger.warn(`llm-openai: Codex Web settings listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };
  const webSettingsService = Object.freeze({
    get: webOptions,
    subscribe(listener) {
      if (typeof listener !== "function") throw new TypeError("llm-openai: Codex Web settings listener must be a function");
      webSettingsListeners.add(listener);
      return () => webSettingsListeners.delete(listener);
    },
  });
  ctx.provide(CODEX_TRANSPORT_SERVICE, codexTransport);
  ctx.provide("openaiCodexWebSettings", webSettingsService);

  const adapter = createDshAdapter(ctx, profiles, resolveApiKey);

  ctx.llm.registerConfigurableProviders([
    {
      provider: PROVIDER,
      displayName: DISPLAY_NAME,
      settingsNs: NS,
      settingsPath: [],
    },
  ]);
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter);
  let registeredPolicy = options().retryPolicy;
  const ensureRegistrationFacts = () => {
    const policy = options().retryPolicy;
    if (deepEqualJson(policy, registeredPolicy)) return;
    registration.replace([PROVIDER]);
    registeredPolicy = policy;
  };

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source;
    },
    validate: (value) => {
      resolveAdapterOptions(value);
      resolveCodexWebOptions(value.codexWeb);
    },
    onChange: () => {
      ensureRegistrationFacts();
      notifyWebSettings();
    },
  });
}

function createSubscriptionPiProvider(baseURL = DEFAULT_BASE_URL) {
  return buildPiProvider(openaiCodexProvider(), {
    baseURL: trustedBaseURL(baseURL),
  });
}

export {
  CODEX_TRANSPORT_SERVICE,
  CodexWebConfig,
  Config,
  DEFAULT_BASE_URL,
  DISPLAY_NAME,
  NS,
  PROVIDER,
  apply,
  createDshAdapter,
  createOpenAiCodexTransport,
  createSubscriptionPiProvider,
  extractChatGptAccountId,
  gptModelCatalog,
  inOpenAIProxyContext,
  inject,
  name,
  resolveAdapterOptions,
  resolveCodexWebOptions,
  resolveOAuthAccessToken,
  trustedBaseURL,
  validateCodexTransportRequest,
};
