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

const Config = z.object({
  baseURL: z.string().default(DEFAULT_BASE_URL),
  streamIdleTimeoutMs: z
    .number()
    .min(Number.MIN_VALUE)
    .max(MAX_TIMER_DELAY_MS)
    .default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
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
    onChange: ensureRegistrationFacts,
  });
}

function createSubscriptionPiProvider(baseURL = DEFAULT_BASE_URL) {
  return buildPiProvider(openaiCodexProvider(), {
    baseURL: trustedBaseURL(baseURL),
  });
}

export {
  Config,
  DEFAULT_BASE_URL,
  DISPLAY_NAME,
  NS,
  PROVIDER,
  apply,
  createDshAdapter,
  createSubscriptionPiProvider,
  gptModelCatalog,
  inOpenAIProxyContext,
  inject,
  name,
  resolveAdapterOptions,
  resolveOAuthAccessToken,
  trustedBaseURL,
};
