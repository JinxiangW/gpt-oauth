import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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
import { installGlobalFetchProxy } from "./proxy.mjs";

// Make undici/openai's global fetch honor DSH_OPENAI_PROXY/HTTPS_PROXY, and
// Windows' system proxy on win32 (Node does not read the registry proxy).
installGlobalFetchProxy();

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

function resolveAdapterOptions(config) {
  const baseURL = (config.baseURL ?? DEFAULT_BASE_URL).trim();
  if (!/^https?:\/\//i.test(baseURL)) {
    throw new Error(`llm-openai: baseURL must be an http(s) URL`);
  }
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
  const models = openaiCodexProvider()
    .getModels()
    .filter((model) => typeof model.id === "string" && model.id.startsWith("gpt-"))
    .map((model) =>
      alignSubscriptionThinking({
        ...model,
        baseUrl: baseURL.replace(/\/+$/, ""),
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
// builds its base options explicitly and calls stream() directly.
function codexWireModel(model) {
  if (typeof model?.id !== "string" || !model.id.endsWith(FAST_SUFFIX)) {
    return { model };
  }
  return {
    model: { ...model, id: model.id.slice(0, -FAST_SUFFIX.length) },
    serviceTier: FAST_SERVICE_TIER,
  };
}

function codexStream(baseProvider, model, context, options) {
  const wire = codexWireModel(model);
  return baseProvider.stream(
    wire.model,
    context,
    wire.serviceTier === undefined ? options : { ...options, serviceTier: wire.serviceTier },
  );
}

function codexStreamSimple(baseProvider, model, context, options) {
  const wire = codexWireModel(model);
  if (wire.serviceTier === undefined) return baseProvider.streamSimple(model, context, options);

  const base = buildBaseOptions(wire.model, context, options, options?.apiKey);
  const clampedReasoning =
    options?.reasoning === undefined ? undefined : clampThinkingLevel(wire.model, options.reasoning);
  const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;
  return baseProvider.stream(wire.model, context, {
    ...base,
    reasoningEffort,
    serviceTier: wire.serviceTier,
  });
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

function oauthCredential(value) {
  if (typeof value !== "object" || value === null) return undefined;
  if (typeof value.access !== "string" || value.access.length === 0) return undefined;
  if (typeof value.refresh !== "string" || value.refresh.length === 0) return undefined;
  if (!Number.isFinite(value.expires)) return undefined;
  return {
    access: value.access,
    refresh: value.refresh,
    expires: value.expires,
  };
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function readOAuthSource(path) {
  const doc = await readJson(path);
  if (typeof doc !== "object" || doc === null) return undefined;

  const rootEntry = doc.openai;
  if (rootEntry !== undefined) {
    const credential = oauthCredential(rootEntry);
    if (credential === undefined) return undefined;
    return { path, doc, entry: rootEntry, credential, kind: "root" };
  }

  const providersEntry = doc.providers?.openai;
  if (providersEntry !== undefined) {
    const credential = oauthCredential(providersEntry);
    if (credential === undefined) return undefined;
    return { path, doc, entry: providersEntry, credential, kind: "providers" };
  }

  const credential = oauthCredential(doc);
  if (credential === undefined) return undefined;
  return { path, doc, entry: doc, credential, kind: "direct" };
}

async function writeOAuthFile(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}

async function persistOAuthSource(source, fresh) {
  if (source.kind === "direct") {
    await writeOAuthFile(source.path, fresh);
    return;
  }
  const updated = {
    ...source.entry,
    access: fresh.access,
    refresh: fresh.refresh,
    expires: fresh.expires,
  };
  if (source.kind === "providers") {
    await writeOAuthFile(source.path, {
      ...source.doc,
      providers: {
        ...source.doc.providers,
        openai: updated,
      },
    });
  } else {
    await writeOAuthFile(source.path, {
      ...source.doc,
      openai: updated,
    });
  }
}

async function refreshOAuthToken(refreshToken) {
  let response;
  try {
    response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }),
    });
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

async function freshAccessFor(source) {
  const credential = source.credential;
  if (credential.expires > Date.now() + TOKEN_REFRESH_SKEW_MS) return credential.access;

  let flight = refreshFlights.get(source.path);
  if (flight === undefined) {
    flight = (async () => {
      const fresh = await refreshOAuthToken(credential.refresh);
      await persistOAuthSource(source, fresh);
      return fresh;
    })().finally(() => refreshFlights.delete(source.path));
    refreshFlights.set(source.path, flight);
  }
  const fresh = await flight;
  return fresh.access;
}

async function resolveOAuthAccessToken(logger = console) {
  const paths = [ownOAuthPath(), ...openCodeAuthCandidates()];
  for (const path of paths) {
    let source;
    try {
      source = await readOAuthSource(path);
    } catch (error) {
      logger.warn?.(`llm-openai: cannot read OpenAI OAuth store ${path}`);
      logger.warn?.(error);
      continue;
    }
    if (source === undefined) continue;
    try {
      return await freshAccessFor(source);
    } catch (error) {
      logger.warn?.(`llm-openai: OpenAI subscription token from ${path} could not be refreshed; trying the next source`);
      logger.warn?.(error);
    }
  }
  return undefined;
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

  const adapter = new PiAiAdapter({ profiles, resolveApiKey });

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
    baseURL: baseURL.replace(/\/+$/, ""),
  });
}

export {
  Config,
  DEFAULT_BASE_URL,
  DISPLAY_NAME,
  NS,
  PROVIDER,
  apply,
  createSubscriptionPiProvider,
  gptModelCatalog,
  inject,
  name,
  resolveAdapterOptions,
  resolveOAuthAccessToken,
};
