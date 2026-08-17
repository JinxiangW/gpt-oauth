import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";

export function oauthCredential(value) {
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

export async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function readOAuthSource(path) {
  const doc = await readJson(path);
  if (doc === undefined) return undefined;
  if (typeof doc !== "object" || doc === null) {
    throw new Error(`OpenAI OAuth store ${path} does not contain a JSON object`);
  }

  if (doc.openai !== undefined) {
    const credential = oauthCredential(doc.openai);
    if (credential === undefined) throw new Error(`OpenAI OAuth store ${path} contains an invalid openai credential`);
    return { path, doc, entry: doc.openai, credential, kind: "root" };
  }

  if (doc.providers?.openai !== undefined) {
    const credential = oauthCredential(doc.providers.openai);
    if (credential === undefined) throw new Error(`OpenAI OAuth store ${path} contains an invalid providers.openai credential`);
    return { path, doc, entry: doc.providers.openai, credential, kind: "providers" };
  }

  const credential = oauthCredential(doc);
  if (credential !== undefined) return { path, doc, entry: doc, credential, kind: "direct" };

  const looksLikeDirectCredential = ["access", "refresh", "expires", "type"].some((key) => key in doc);
  if (looksLikeDirectCredential) throw new Error(`OpenAI OAuth store ${path} contains an invalid credential`);
  return undefined;
}

function documentWithCredential(source, fresh) {
  if (source.kind === "direct") return { ...source.doc, ...fresh };
  const updated = {
    ...source.entry,
    access: fresh.access,
    refresh: fresh.refresh,
    expires: fresh.expires,
  };
  if (source.kind === "providers") {
    return {
      ...source.doc,
      providers: {
        ...source.doc.providers,
        openai: updated,
      },
    };
  }
  return { ...source.doc, openai: updated };
}

export async function writeOAuthFileAtomic(path, value) {
  await writeFileAtomic(path, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
    dirMode: 0o700,
  });
}

export async function withOAuthFileLock(path, operation) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  return withFileLock(path, operation);
}

export async function saveOAuthCredentials(path, credentials) {
  return withOAuthFileLock(path, async () => {
    await writeOAuthFileAtomic(path, credentials);
    return path;
  });
}

export async function freshAccessFromOwnStore(path, refresh, skewMs, now = Date.now) {
  return withOAuthFileLock(path, async () => {
    const current = await readOAuthSource(path);
    if (current === undefined) throw new Error(`OpenAI OAuth store disappeared while waiting for its writer lock: ${path}`);
    if (current.credential.expires > now() + skewMs) return current.credential.access;

    const fresh = await refresh(current.credential.refresh);
    await writeOAuthFileAtomic(path, documentWithCredential(current, fresh));
    return fresh.access;
  });
}
