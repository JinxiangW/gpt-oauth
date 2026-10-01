import { access, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { Context } from "@deepseek-ai/cordis";
import LocalCredentialProvider from "@deepseek-ai/dsh-credentials-local";
import { credentialKey, credentialKeyId, credentialKeyScope, isCredentialRefName, credentialRef } from "@deepseek-ai/dsh-credentials";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { LlmError } from "@deepseek-ai/dsh-llm";
import { readOAuthSource } from "./oauth-store.mjs";
import { browserLogin, deviceLogin } from "./login.mjs";
import { withOpenAIProxy } from "./proxy.mjs";

const PROVIDER = "openai-codex";
const OAUTH_CREDENTIAL_KEY = credentialKey("llm-openai", PROVIDER);

function ownOAuthPath() {
  return dshHomePath("openai-oauth.json");
}

function oauthCredential(value) {
  if (typeof value !== "object" || value === null || value.type !== "oauth") return undefined;
  if (typeof value.access !== "string" || value.access.length === 0) return undefined;
  if (typeof value.refresh !== "string" || value.refresh.length === 0) return undefined;
  if (!Number.isFinite(value.expires)) return undefined;
  return { ...value, type: "oauth" };
}

function credentialFromRecord(record) {
  return record?.kind === "grant" ? oauthCredential(record.payload) : undefined;
}

function grantRecord(credential) {
  const checked = oauthCredential(credential);
  if (checked === undefined) throw new TypeError("llm-openai: OpenAI OAuth credential is invalid");
  return { kind: "grant", payload: checked };
}

async function readOwnLegacyCredential() {
  const source = await readOAuthSource(ownOAuthPath());
  if (source === undefined) return undefined;
  return { ...source.credential, type: "oauth" };
}

function writableCredentials(ctx) {
  const credentials = ctx.get("credentials");
  if (credentials === undefined) {
    throw new LlmError(
      "llm-openai: this DSH composition has no credential store; mount @deepseek-ai/dsh-credentials-local",
      "NO_CREDENTIAL_STORE",
    );
  }
  return credentials;
}

function createOpenAiCredentialStore(ctx, { readLegacy = readOwnLegacyCredential, removeLegacy = true } = {}) {
  return Object.freeze({
    async read(providerId) {
      if (providerId !== PROVIDER) return undefined;
      const credentials = ctx.get("credentials");
      const stored = credentials === undefined
        ? undefined
        : credentialFromRecord(await credentials.readRecord(OAUTH_CREDENTIAL_KEY));
      return stored ?? readLegacy();
    },
    async list() {
      const credentials = ctx.get("credentials");
      if (credentials !== undefined) {
        const records = await credentials.listRecords();
        if (records.some((entry) =>
          credentialKeyScope(entry.key) === "llm-openai" &&
          credentialKeyId(entry.key) === PROVIDER &&
          entry.kind === "grant"
        )) {
          return [{ providerId: PROVIDER, type: "oauth" }];
        }
      }
      return (await readLegacy()) === undefined
        ? []
        : [{ providerId: PROVIDER, type: "oauth" }];
    },
    async modify(providerId, mutate) {
      if (providerId !== PROVIDER) {
        throw new LlmError(`llm-openai: cannot store a credential for provider "${providerId}"`, "UNSTORABLE_PROVIDER_ID");
      }
      const credentials = writableCredentials(ctx);
      let decided;
      const persisted = await credentials.modifyRecord(OAUTH_CREDENTIAL_KEY, async (current) => {
        const before = credentialFromRecord(current) ?? await readLegacy();
        const next = await mutate(before);
        decided = next ?? before;
        return next === undefined ? undefined : grantRecord(next);
      });
      return credentialFromRecord(persisted) ?? decided;
    },
    async delete(providerId) {
      if (providerId !== PROVIDER) return;
      await writableCredentials(ctx).deleteRecord(OAUTH_CREDENTIAL_KEY);
      if (removeLegacy) {
        await unlink(ownOAuthPath()).catch((error) => {
          if (error?.code !== "ENOENT") throw error;
        });
      }
    },
  });
}

function createOpenAiAuthContext(ctx) {
  return Object.freeze({
    async env(name) {
      if (isCredentialRefName(name)) {
        const hit = await ctx.get("credentials")?.resolve(credentialRef(name));
        if (hit !== undefined) return hit.value;
      }
      return launchEnvironmentOf(ctx).get(name)?.value;
    },
    async fileExists(path) {
      const expanded = path === "~" || path.startsWith("~/")
        ? resolve(homedir(), path.slice(1).replace(/^\//, ""))
        : path;
      try {
        await access(expanded);
        return true;
      } catch {
        return false;
      }
    },
  });
}

function createOpenAiAuth(ctx) {
  return Object.freeze({
    credentials: createOpenAiCredentialStore(ctx),
    authContext: createOpenAiAuthContext(ctx),
  });
}

async function withLocalCredentialContext(operation) {
  const ctx = new Context();
  const fiber = ctx.plugin(LocalCredentialProvider, { watch: false });
  await fiber;
  try {
    return await operation(ctx);
  } finally {
    await fiber.dispose();
  }
}

async function saveOpenAiCredential(credential) {
  return withLocalCredentialContext(async (ctx) => {
    await ctx.credentials.modifyRecord(OAUTH_CREDENTIAL_KEY, async () => grantRecord(credential));
    return dshHomePath(".credentials.yaml");
  });
}

async function resolveStoredOAuthAccessToken() {
  return withLocalCredentialContext(async (ctx) => {
    const resolveAccess = createOpenAiAccessTokenResolver(createOpenAiAuth(ctx));
    return resolveAccess();
  });
}

async function migrateLegacyOAuthCredential(ctx, logger = ctx.logger ?? console) {
  const credentials = ctx.get("credentials");
  if (credentials === undefined) return false;
  let legacy;
  try {
    legacy = await readOwnLegacyCredential();
  } catch (error) {
    logger.warn?.("llm-openai: legacy OAuth credential could not be read; leaving it untouched");
    logger.warn?.(error);
    return false;
  }
  if (legacy === undefined) return false;

  let migrated = false;
  await credentials.modifyRecord(OAUTH_CREDENTIAL_KEY, async (current) => {
    if (credentialFromRecord(current) !== undefined) return undefined;
    migrated = true;
    return grantRecord(legacy);
  });
  if (!migrated) return false;
  try {
    await unlink(ownOAuthPath());
  } catch (error) {
    if (error?.code !== "ENOENT") {
      logger.warn?.("llm-openai: migrated OAuth into DSH credentials but could not remove the legacy file");
      logger.warn?.(error);
    }
  }
  logger.info?.("llm-openai: migrated the legacy OpenAI OAuth file into the DSH credential store");
  return true;
}

function registerOpenAiAuthorizationFlow(ctx) {
  return ctx.authorization.registerFlow({
    key: OAUTH_CREDENTIAL_KEY,
    label: "OpenAI (ChatGPT subscription)",
    methods: [
      { id: "browser", label: "Sign in with ChatGPT" },
      { id: "device-code", label: "Device code (headless)" },
    ],
    async run(session) {
      const credential = session.method === "device-code"
        ? await deviceLogin({
          signal: session.signal,
          notify: (notice) => session.notify(notice),
        })
        : await browserLogin({
          signal: session.signal,
          openBrowser: false,
          notify: (notice) => session.notify(notice),
        });
      await writableCredentials(ctx).modifyRecord(OAUTH_CREDENTIAL_KEY, async () => grantRecord(credential));
    },
  });
}

function createOpenAiAccessTokenResolver(auth) {
  const models = createModels(auth);
  models.setProvider(openaiCodexProvider());
  return async () => {
    const resolved = await withOpenAIProxy(() => models.getAuth(PROVIDER));
    const access = resolved?.auth.apiKey;
    return typeof access === "string" && access.length > 0 ? access : undefined;
  };
}

export {
  OAUTH_CREDENTIAL_KEY,
  createOpenAiAccessTokenResolver,
  createOpenAiAuth,
  createOpenAiAuthContext,
  createOpenAiCredentialStore,
  credentialFromRecord,
  grantRecord,
  migrateLegacyOAuthCredential,
  oauthCredential,
  ownOAuthPath,
  readOwnLegacyCredential,
  registerOpenAiAuthorizationFlow,
  resolveStoredOAuthAccessToken,
  saveOpenAiCredential,
  withLocalCredentialContext,
};
