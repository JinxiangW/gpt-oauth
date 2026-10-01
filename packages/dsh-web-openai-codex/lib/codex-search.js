import { WebError } from "@deepseek-ai/dsh-web";

const OPENAI_CODEX_PROVIDER = "openai-codex";
const DEFAULT_ASSISTANT_CONTEXT_TOKENS = 1000;
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
// Wire model used when the DSH session itself is not on the openai-codex route.
// `alpha/search` needs a model name; it does not need the session to own that
// model, so any GPT search model in the ChatGPT catalog can serve.
const DEFAULT_SEARCH_MODEL = "gpt-5.4";
const MAX_MODEL_CHARS = 200;
const CHARS_PER_TOKEN_ESTIMATE = 4;
const MAX_SEARCH_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_SEARCH_OUTPUT_CHARS = 1_000_000;
const MAX_SOURCE_URL_CHARS = 8_192;
const MAX_SOURCE_TITLE_CHARS = 1_000;
const MAX_SOURCE_SNIPPET_CHARS = 10_000;
const MAX_SOURCE_DATE_CHARS = 200;

function textOf(message) {
  return (message?.content ?? [])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

function isVisibleUserMessage(message) {
  return message?.role === "user" &&
    message.source?.kind === "user" &&
    (message.content ?? []).some((block) => block?.type === "text") &&
    !(message.content ?? []).some((block) => block?.type === "tool-result");
}

function isVisibleAssistantMessage(message) {
  return message?.role === "assistant" && message.source?.kind === "model";
}

function responseMessage(role, text) {
  return {
    type: "message",
    role,
    content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
  };
}

export function recentCodexSearchInput(messages, assistantTokenLimit = DEFAULT_ASSISTANT_CONTEXT_TOKENS) {
  if (!Number.isInteger(assistantTokenLimit) || assistantTokenLimit < 1) {
    throw new Error("web-openai-codex: assistantContextTokens must be a positive integer");
  }
  const visible = [];
  for (const message of messages ?? []) {
    const text = textOf(message);
    if (text.length === 0) continue;
    if (isVisibleUserMessage(message)) visible.push({ role: "user", text });
    else if (isVisibleAssistantMessage(message)) visible.push({ role: "assistant", text });
  }
  const userIndexes = [];
  for (let index = 0; index < visible.length; index += 1) {
    if (visible[index].role === "user") userIndexes.push(index);
  }
  const latestUser = userIndexes.at(-1);
  const start = userIndexes.length > 1 ? userIndexes.at(-2) : latestUser;
  if (start === undefined || latestUser === undefined) return undefined;
  const tail = visible.slice(start, latestUser + 1);
  const assistantCharacterLimit = assistantTokenLimit * CHARS_PER_TOKEN_ESTIMATE;
  let assistantCharacters = 0;
  const projected = [];
  for (const item of tail) {
    if (item.role === "assistant") {
      const remaining = assistantCharacterLimit - assistantCharacters;
      if (remaining <= 0) continue;
      const text = item.text.length <= remaining ? item.text : item.text.slice(0, remaining);
      assistantCharacters += text.length;
      projected.push(responseMessage("assistant", text));
    } else {
      projected.push(responseMessage("user", item.text));
    }
  }
  return projected.length > 0 ? projected : undefined;
}

export function codexWireModel(model) {
  if (typeof model !== "string" || model.length === 0) {
    throw new WebError("the current DSH session has no model for Codex web search", "WEB_CODEX_MODEL_UNAVAILABLE");
  }
  return model.endsWith("-fast") ? model.slice(0, -"-fast".length) : model;
}

/**
 * Resolve the wire model for one search. The session's own route wins when it
 * already is `openai-codex`; otherwise the configured `searchModel` serves, so a
 * DeepSeek (or any other) session still searches through GPT.
 */
export function resolveCodexSearchModel(route, searchModel) {
  if (route?.provider === OPENAI_CODEX_PROVIDER) return codexWireModel(route.model);
  if (typeof searchModel !== "string" || searchModel.trim().length === 0) {
    throw new WebError(
      "Codex web search needs a configured searchModel because the current DSH session is not on the openai-codex provider",
      "WEB_CODEX_MODEL_UNAVAILABLE",
    );
  }
  const configured = codexWireModel(searchModel.trim());
  if (configured.length > MAX_MODEL_CHARS || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(configured)) {
    throw new WebError(`Codex web search searchModel is not a valid wire model id: ${configured.slice(0, MAX_MODEL_CHARS)}`, "WEB_CODEX_MODEL_UNAVAILABLE");
  }
  return configured;
}

export function buildCodexSearchRequest({ session, query, maxResults, assistantContextTokens, maxOutputTokens, searchModel }) {
  const route = session.requestContext();
  const model = resolveCodexSearchModel(route, searchModel);
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new WebError("Codex web search query must not be blank", "WEB_CODEX_INVALID_QUERY");
  }
  const outputBudget = maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  if (!Number.isInteger(outputBudget) || outputBudget < 1) {
    throw new Error("web-openai-codex: searchMaxOutputTokens must be a positive integer");
  }
  const resultLimit = Number.isInteger(maxResults) && maxResults > 0 ? maxResults : 8;
  // Conversation context is only projected when the session itself is a Codex
  // session. A DeepSeek conversation must not be uploaded to the ChatGPT backend
  // just to answer a search query.
  const input = route?.provider === OPENAI_CODEX_PROVIDER
    ? recentCodexSearchInput(session.deriveMessages(), assistantContextTokens)
    : undefined;
  return {
    id: String(session.id),
    model,
    input,
    commands: {
      search_query: [{ q: query.trim() }],
      response_length: resultLimit <= 4 ? "short" : resultLimit <= 8 ? "medium" : "long",
    },
    settings: {
      allowed_callers: ["direct"],
      external_web_access: true,
    },
    max_output_tokens: outputBudget,
  };
}

function optionalString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function boundedOptionalString(value, maxChars) {
  const text = optionalString(value);
  if (text === undefined) return undefined;
  return text.slice(0, maxChars);
}

function httpUrl(value) {
  const raw = optionalString(value);
  if (raw === undefined || raw.length > MAX_SOURCE_URL_CHARS) return undefined;
  try {
    const parsed = new URL(raw);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function sourceFromKnownResult(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  // Codex intentionally exposes `results` as opaque JSON. `text_result` is the
  // only URL-bearing DTO covered by the tagged public endpoint contract; do not
  // guess at future variants merely because an unknown object contains `url`.
  if (value.type !== "text_result") return undefined;
  const url = httpUrl(value.url);
  if (url === undefined) return undefined;
  const title = boundedOptionalString(value.title, MAX_SOURCE_TITLE_CHARS);
  const snippet = boundedOptionalString(value.snippet, MAX_SOURCE_SNIPPET_CHARS);
  const publishedAt = boundedOptionalString(value.published_at ?? value.publishedAt, MAX_SOURCE_DATE_CHARS);
  return {
    url,
    ...(title !== undefined ? { title } : {}),
    ...(snippet !== undefined ? { snippet } : {}),
    ...(publishedAt !== undefined ? { publishedAt } : {}),
  };
}

export function mapCodexSearchResponse(payload, maxResults = 8) {
  if (typeof payload !== "object" || payload === null) {
    throw new WebError("Codex web search returned a non-object response", "WEB_CODEX_PROTOCOL_ERROR");
  }
  const rawContent = optionalString(payload.output);
  const content = rawContent?.slice(0, MAX_SEARCH_OUTPUT_CHARS);
  const contentTruncated = rawContent !== undefined && rawContent.length > MAX_SEARCH_OUTPUT_CHARS;
  const collected = Array.isArray(payload.results)
    ? payload.results.map(sourceFromKnownResult).filter((source) => source !== undefined)
    : [];
  const unique = [];
  const seen = new Set();
  for (const source of collected) {
    if (seen.has(source.url)) continue;
    seen.add(source.url);
    unique.push(source);
  }
  if (unique.length === 0) {
    throw new WebError(
      "Codex web search returned no parseable source URLs; retry or disable Codex Web to use DSH's default search provider",
      "WEB_CODEX_CITATIONS_MISSING",
    );
  }
  const limit = Number.isInteger(maxResults) && maxResults > 0 ? maxResults : 8;
  return {
    ...(content !== undefined ? { content } : {}),
    sources: unique.slice(0, limit),
    truncated: contentTruncated || unique.length > limit,
  };
}

async function cancelResponseBody(response) {
  try {
    await response.body?.cancel?.();
  } catch {
    // The connection is already unusable; cancellation is best-effort cleanup.
  }
}

async function boundedResponseText(response, maxBytes = MAX_SEARCH_RESPONSE_BYTES) {
  const rawLength = response.headers?.get?.("content-length");
  const declaredLength = rawLength === null || rawLength === undefined ? undefined : Number(rawLength);
  if (declaredLength !== undefined && Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await cancelResponseBody(response);
    throw new WebError("Codex web search response exceeds the byte limit", "WEB_CODEX_RESPONSE_TOO_LARGE");
  }
  if (response.body === null || response.body === undefined) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        await reader.cancel();
        throw new WebError("Codex web search response exceeds the byte limit", "WEB_CODEX_RESPONSE_TOO_LARGE");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function responseError(response) {
  let text;
  try {
    text = await boundedResponseText(response);
  } catch (error) {
    if (error instanceof WebError) throw error;
    return "";
  }
  try {
    const payload = JSON.parse(text);
    return boundedOptionalString(payload?.error?.message ?? payload?.error ?? payload?.message, 400) ?? "";
  } catch {
    return text.slice(0, 400);
  }
}

export class CodexSearchProvider {
  id = "openai-codex-search";

  constructor({ transport, resolveOptions, resolveAgent = () => undefined }) {
    this.transport = transport;
    this.resolveOptions = resolveOptions;
    this.resolveAgent = resolveAgent;
  }

  available() {
    return typeof this.transport?.request === "function";
  }

  async search(request, signal, explicitAgent, explicitOptions) {
    const agent = explicitAgent ?? this.resolveAgent();
    if (agent === undefined) {
      throw new WebError("Codex web search requires a live initiating DSH agent", "WEB_CODEX_AGENT_REQUIRED");
    }
    const options = explicitOptions ?? this.resolveOptions();
    const body = buildCodexSearchRequest({
      session: agent.session,
      query: request.query,
      maxResults: request.maxResults,
      assistantContextTokens: options.assistantContextTokens,
      maxOutputTokens: options.searchMaxOutputTokens,
      searchModel: options.searchModel,
    });
    let response;
    try {
      response = await this.transport.request({ path: "alpha/search", method: "POST", body, signal });
    } catch (error) {
      if (signal?.aborted || error?.code === "ABORTED") throw new WebError("Codex web search aborted", "WEB_ABORTED", { cause: error });
      if (error?.code === "MISSING_CREDENTIAL") throw new WebError(error.message, "WEB_PROVIDER_CREDENTIAL_MISSING", { cause: error });
      throw new WebError(`Codex web search request failed: ${error instanceof Error ? error.message : String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
    }
    if (!response.ok) {
      const detail = await responseError(response);
      const suffix = detail.length > 0 ? `: ${detail}` : "";
      throw new WebError(`Codex web search API error (HTTP ${response.status})${suffix}`, "WEB_PROVIDER_ERROR");
    }
    let payload;
    try {
      payload = JSON.parse(await boundedResponseText(response));
    } catch (error) {
      if (error instanceof WebError) throw error;
      throw new WebError("Codex web search returned invalid JSON", "WEB_CODEX_PROTOCOL_ERROR", { cause: error });
    }
    return mapCodexSearchResponse(payload, request.maxResults);
  }
}

export const CODEX_SEARCH_DEFAULTS = Object.freeze({
  assistantContextTokens: DEFAULT_ASSISTANT_CONTEXT_TOKENS,
  searchMaxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  searchModel: DEFAULT_SEARCH_MODEL,
});
