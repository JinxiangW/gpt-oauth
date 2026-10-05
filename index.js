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
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { bootLog, bootLogError, bootLogStart } from "./boot-log.mjs";
import { supplementCodexCatalog } from "./codex-catalog.mjs";
import { MAX_TIMER_DELAY_MS } from "@deepseek-ai/dsh-timeout";
import z from "@deepseek-ai/schemastery";
import { freshAccessFromOwnStore, readOAuthSource } from "./oauth-store.mjs";
import {
  OAUTH_CREDENTIAL_KEY,
  createOpenAiAccessTokenResolver,
  createOpenAiAuth,
  migrateLegacyOAuthCredential,
  registerOpenAiAuthorizationFlow,
  resolveStoredOAuthAccessToken,
} from "./auth.mjs";
import {
  installScopedFetchProxy,
  proxyConfiguredFor,
  withOpenAIProxy,
} from "./proxy.mjs";

// The compatibility shim is process-global because pi-ai calls global fetch,
// but it changes behavior only inside withOpenAIProxy()'s async context.
installScopedFetchProxy();

const name = "llm-openai";
const inject = ["llm", "credentials"];

const PROVIDER = "openai-codex";
const DISPLAY_NAME = "OpenAI (ChatGPT)";
// DSH 0.2 replaced the settings.yaml sections with per-Loader-entry config, so
// this is now only the namespace reported to ctx.llm.registerConfigurableProviders
// (the Models page edits the entry config itself).
const NS = "llm-openai/openai-codex";

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

// The installed pi-ai Codex catalog ships "-fast" selector siblings for these
// ChatGPT models: same wire model id, plus `service_tier: "priority"` on the
// request. The list is maintained here (sync it when the pi-ai catalog changes)
// because pi-ai itself does not expose a per-model priority-tier capability.
const FAST_SUFFIX = "-fast";
const FAST_SERVICE_TIER = "priority";
// Retired from ChatGPT subscription Codex on 2026-09-14; still present in
// the Harness's bundled 0.87.1 catalog.
const RETIRED_CODEX_MODEL_IDS = new Set(["gpt-5.3-codex-spark"]);
const FAST_MODEL_IDS = new Set([
  "gpt-5.5",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-6-astra",
  "gpt-6-luna",
  "gpt-6-sol",
  "gpt-6.1-sol",
]);

const Config = z.object({
  baseURL: z.string().default(DEFAULT_BASE_URL),
  streamIdleTimeoutMs: z
    .number()
    .min(Number.MIN_VALUE)
    .max(MAX_TIMER_DELAY_MS)
    .default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
});

// Retry-policy change detection. dsh 0.1.1 exported this predicate from
// @deepseek-ai/dsh-settings and dsh 0.2.0 from @deepseek-ai/dsh-util-values,
// which does not exist in 0.1.1; the relation is plain JSON structural equality
// (keys order-independent, array order significant), so it is implemented here
// instead of pinning the plugin to one runtime's utility package.
function deepEqualJson(left, right) {
  if (left === right) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (typeof left !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) {
    return left.length === right.length && left.every((entry, index) => deepEqualJson(entry, right[index]));
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => Object.hasOwn(right, key) && deepEqualJson(left[key], right[key]));
}

function trustedBaseURL(value = DEFAULT_BASE_URL) {  let url;
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

function alignSubscriptionThinking(model) {
  if (!model.reasoning) return model;
  const declared = model.thinkingLevelMap ?? {};
  return {
    ...model,
    // Keep the upstream capability map: Astra/6.1 Sol forbid off, while
    // GPT-6 offers Max. Hide the redundant minimal-to-low selector alias.
    thinkingLevelMap: Object.fromEntries(
      ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => [
        level,
        level === "minimal" ? null
          : level === "off" ? (Object.hasOwn(declared, level) ? declared[level] : "none")
          : level === "xhigh" || level === "max" ? (declared[level] ?? null)
          : (Object.hasOwn(declared, level) ? declared[level] : level),
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
  const models = supplementCodexCatalog(openaiCodexProvider().getModels())
    .filter((model) => typeof model.id === "string" && model.id.startsWith("gpt-") && !RETIRED_CODEX_MODEL_IDS.has(model.id))
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
    auth: baseProvider.auth ?? { apiKey: harnessApiKeyAuth(DISPLAY_NAME) },
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
    // PiAiAdapter.modelOf() reads these two diagnostics on every profile, so a
    // profile that omits them makes resolveModel() throw and the GUI catalog
    // drops the whole provider group silently (buildModelCatalog turns the throw
    // into a provider failure, then filters out empty groups). This adapter owns
    // one static catalog, so both are genuinely empty rather than unavailable.
    modelErrors: new Map(),
    catalogError: undefined,
  };
}

// â”€â”€ OAuth token store / opencode fallback â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
      signal: AbortSignal.timeout(60_000),
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
  const stored = await resolveStoredOAuthAccessToken();
  if (stored !== undefined) return stored;

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
        const error = new Error("llm-openai: no ChatGPT subscription credential is available; run dsh-openai-login");
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

// A model id that is deliberately not a GPT model: it exists only so a failed
// adapter still yields one visible, self-explanatory entry in the model picker.
// `buildModelCatalog` drops provider groups whose model list is empty, so a route
// registered with nothing to show would be invisible â€” exactly the failure mode
// this sentinel removes.
const DIAGNOSTIC_MODEL_ID = "route-unavailable";

function diagnosticAdapter(reason) {
  const model = {
    id: DIAGNOSTIC_MODEL_ID,
    name: `Unavailable: ${reason}`,
    input: ["text"],
  };
  return {
    providerInfo: () => ({ id: PROVIDER, name: DISPLAY_NAME }),
    listModels: () => Promise.resolve([{
      provider: PROVIDER,
      id: DIAGNOSTIC_MODEL_ID,
      name: model.name,
      inputModalities: ["text"],
    }]),
    resolveModel: () => Promise.resolve({
      provider: PROVIDER,
      id: DIAGNOSTIC_MODEL_ID,
      name: model.name,
      inputModalities: ["text"],
      context: { contextWindow: 1 },
    }),
    providerRetryPolicy: () => undefined,
    stream: () => {
      throw new LlmError(`llm-openai: ${reason}`, "NO_ADAPTER");
    },
    streamSimple: () => {
      throw new LlmError(`llm-openai: ${reason}`, "NO_ADAPTER");
    },
  };
}

function createDshAdapter(ctx, profiles, resolveApiKey, auth = createOpenAiAuth(ctx)) {
  return new PiAiAdapter({
    profiles,
    resolveApiKey,
    auth,
    resolveAttachments: () => ctx.get("attachments"),
  });
}

function apply(ctx, config) {
  bootLogStart("llm-openai");
  bootLog("llm-openai", `entry: ${import.meta.url}`);
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
  options();

  const baseProvider = openaiCodexProvider();
  let profileCache;
  const profiles = () => {
    const connection = options();
    if (profileCache?.connection === connection) return profileCache.profiles;
    const next = new Map([[PROVIDER, buildProfile(baseProvider, connection)]]);
    profileCache = { connection, profiles: next };
    return next;
  };

  const auth = createOpenAiAuth(ctx);
  const resolveStoredAccess = createOpenAiAccessTokenResolver(auth);
  const resolveApiKey = async () => {
    const oauthAccess = await resolveStoredAccess() ?? await resolveOAuthAccessToken(ctx.logger);
    if (oauthAccess !== undefined) {
      return assertUsableApiKey(oauthAccess, "llm-openai", "OpenAI subscription OAuth");
    }
    throw new LlmError(
      "llm-openai: no ChatGPT subscription credential is available; run dsh-openai-login",
      "MISSING_CREDENTIAL",
    );
  };

  const codexTransport = createOpenAiCodexTransport({
    resolveAccessToken: resolveApiKey,
    logger: ctx.logger,
  });
  ctx.provide(CODEX_TRANSPORT_SERVICE, codexTransport);

  ctx.effect(async function* migrateLegacyCredential() {
    try {
      await migrateLegacyOAuthCredential(ctx);
    } catch (error) {
      ctx.logger.warn("llm-openai: legacy OAuth migration failed; the compatibility fallback remains available");
      ctx.logger.warn(error);
    }
  }, "llm-openai.migrateLegacyOAuthCredential()");
  ctx.inject(["authorization"], (authorizationCtx) => {
    registerOpenAiAuthorizationFlow(authorizationCtx);
  });

  // The chat route and the Codex transport are independent capabilities: web
  // search only needs the transport above, while the GPT model picker needs this
  // registration. Registration is therefore attempted in two steps, and a
  // failure is made *visible in the model picker* instead of only being logged:
  // this plugin runs inside the Electron host, whose stderr nobody reads, so a
  // log-only failure looks exactly like "the models never appeared". A failed
  // adapter is replaced by a diagnostic sentinel so the reason shows up where the
  // user is actually looking.
  const registerRoute = () => {
    bootLog("llm-openai", "step declare-route");
    ctx.llm.registerConfigurableProviders([
      {
        provider: PROVIDER,
        displayName: DISPLAY_NAME,
        settingsNs: NS,
        settingsPath: [],
      },
    ]);
    bootLog("llm-openai", "step declare-route ok");
  };
  try {
    registerRoute();
  } catch (error) {
    // The generic pi-ai adapter declares a route for EVERY provider in its
    // installed catalog, and that catalog contains openai-codex, so this route is
    // normally already declared before this plugin activates. That is expected
    // and harmless: the declaration reserves the route name, while the model list
    // and the wire protocol come from whichever adapter is registered for it, and
    // registerAdapter() replaces the adapter for a route. Aborting here is what
    // previously made the GPT models silently unavailable, so activation
    // continues and the adapter below takes the route over.
    const alreadyDeclared = error?.code === "DUPLICATE_DIRECTORY";
    if (!alreadyDeclared) bootLogError("llm-openai", error);
    bootLog(
      "llm-openai",
      alreadyDeclared
        ? "declare-route already declared by another adapter; continuing to claim the route with this plugin's adapter"
        : "declare-route failed unexpectedly; continuing so the failure stays visible",
    );
    if (!alreadyDeclared) {
      ctx.logger.warn("llm-openai: the openai-codex route could not be declared");
      ctx.logger.warn(error);
    }
  }

  try {
    bootLog("llm-openai", "step create-adapter");
    const adapter = createDshAdapter(ctx, profiles, resolveApiKey, auth);
    bootLog("llm-openai", "step register-adapter");
    const registration = ctx.llm.registerAdapter([PROVIDER], adapter);
    bootLog("llm-openai", "step register-adapter ok");
    let registeredPolicy = options().retryPolicy;
    const ensureRegistrationFacts = () => {
      const policy = options().retryPolicy;
      if (deepEqualJson(policy, registeredPolicy)) return;
      registration.replace([PROVIDER]);
      registeredPolicy = policy;
    };

    // DSH 0.2 has no installSettingsSection: the Loader entry's own config row is
    // the settings surface, so a changed row remounts this plugin and rebuilds the
    // adapter facts. The observer below keeps retry-policy changes honest when the
    // surrounding composition re-resolves config in place instead of remounting.
    ctx.on("internal/config", function (_raw, next) {
      if (this === ctx.fiber) ensureRegistrationFacts();
      return next();
    });
  } catch (error) {
    bootLogError("llm-openai", error);
    const detail = error instanceof Error ? error.message : String(error);
    bootLog("llm-openai", `FAIL adapter registration: ${detail}`);
    ctx.logger.error("llm-openai: the GPT chat adapter could not be registered");
    ctx.logger.error(error);
    try {
      ctx.llm.registerAdapter([PROVIDER], diagnosticAdapter(`adapter registration failed: ${detail}`));
      bootLog("llm-openai", "diagnostic sentinel registered");
    } catch (fallbackError) {
      bootLogError("llm-openai", fallbackError);
      bootLog("llm-openai", "FAIL diagnostic sentinel registration");
      ctx.logger.error("llm-openai: the diagnostic route could not be registered either");
      ctx.logger.error(fallbackError);
    }
  }
  bootLog("llm-openai", `listProviders now: ${(() => {
    try {
      return ctx.llm.listProviders().map((provider) => provider.id).join(",");
    } catch (error) {
      return `unavailable (${error instanceof Error ? error.message : String(error)})`;
    }
  })()}`);
}

function createSubscriptionPiProvider(baseURL = DEFAULT_BASE_URL) {
  return buildPiProvider(openaiCodexProvider(), {
    baseURL: trustedBaseURL(baseURL),
  });
}

export {
  CODEX_TRANSPORT_SERVICE,
  DIAGNOSTIC_MODEL_ID,
  Config,
  DEFAULT_BASE_URL,
  DISPLAY_NAME,
  NS,
  OAUTH_CREDENTIAL_KEY,
  PROVIDER,
  apply,
  buildProfile,
  createDshAdapter,
  createOpenAiAuth,
  createOpenAiCodexTransport,
  createSubscriptionPiProvider,
  diagnosticAdapter,
  extractChatGptAccountId,
  gptModelCatalog,
  inOpenAIProxyContext,
  inject,
  name,
  resolveAdapterOptions,
  resolveOAuthAccessToken,
  trustedBaseURL,
  validateCodexTransportRequest,
};

