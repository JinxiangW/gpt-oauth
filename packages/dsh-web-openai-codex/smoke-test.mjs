#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { CodexSearchProvider } from "./lib/codex-search.js";
import { createSafeHttpFetchProvider } from "./lib/safe-http-fetch.js";

function argValue(args, prefix, fallback) {
  const match = args.find((arg) => arg.startsWith(prefix));
  return match === undefined ? fallback : match.slice(prefix.length);
}

function realUser(text) {
  return {
    id: randomUUID(),
    role: "user",
    source: { kind: "user" },
    content: [{ type: "text", text }],
  };
}

async function loadOAuthCore() {
  try {
    return await import("dsh-llm-openai");
  } catch (packageError) {
    try {
      return await import("../../index.js");
    } catch {
      throw packageError;
    }
  }
}

export async function main(args = process.argv.slice(2), dependencies = {}) {
  if (!args.includes("--live")) {
    console.error("Refusing authenticated search without --live");
    return 2;
  }
  const query = argValue(args, "--query=", "OpenAI Codex CLI official documentation");
  const model = argValue(args, "--model=", "gpt-5.6-sol");
  const oauthCore = dependencies.createTransport !== undefined && dependencies.resolveAccessToken !== undefined
    ? undefined
    : await loadOAuthCore();
  const transport = (dependencies.createTransport ?? oauthCore.createOpenAiCodexTransport)({
    resolveAccessToken: dependencies.resolveAccessToken ?? oauthCore.resolveOAuthAccessToken,
  });
  const search = new CodexSearchProvider({
    transport,
    resolveOptions: () => ({ assistantContextTokens: 1000, searchMaxOutputTokens: 2048 }),
  });
  const session = {
    id: `dsh-web-smoke-${randomUUID()}`,
    requestContext: () => ({ provider: "openai-codex", model }),
    deriveMessages: () => [realUser(query)],
  };

  try {
    const result = await search.search({ query, maxResults: 4 }, undefined, { session });
    console.log(`SEARCH_OK sources=${result.sources.length} truncated=${result.truncated} contentChars=${result.content?.length ?? 0}`);
  } catch (error) {
    console.error(`SEARCH_FAILED code=${error?.code ?? "UNKNOWN"} message=${error instanceof Error ? error.message : String(error)}`);
    return 3;
  }

  const fetch = (dependencies.createFetchProvider ?? createSafeHttpFetchProvider)();
  try {
    const result = await fetch.fetch({ url: "https://example.com/" });
    console.log(`FETCH_OK status=${result.statusCode} kind=${result.body.kind} chars=${result.body.content.length}`);
  } catch (error) {
    console.error(`FETCH_FAILED code=${error?.code ?? "UNKNOWN"} message=${error instanceof Error ? error.message : String(error)}`);
    return 4;
  }

  try {
    await fetch.fetch({ url: "http://127.0.0.1:3080/" });
    console.error("PRIVATE_FETCH_FAILED target unexpectedly allowed");
    return 5;
  } catch (error) {
    if (error?.code !== "WEB_FETCH_BLOCKED_URL") {
      console.error(`PRIVATE_FETCH_FAILED code=${error?.code ?? "UNKNOWN"}`);
      return 5;
    }
    console.log("PRIVATE_FETCH_BLOCKED code=WEB_FETCH_BLOCKED_URL");
  }
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
