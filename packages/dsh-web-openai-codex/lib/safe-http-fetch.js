import { lookup as nodeLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import { Worker } from "node:worker_threads";
import { WebError } from "@deepseek-ai/dsh-web";

export const SAFE_HTTP_FETCH_PROVIDER_ID = "openai-codex-safe-http";
export const DEFAULT_SAFE_HTTP_LIMITS = Object.freeze({
  maxUrlLength: 8192,
  timeoutMs: 60_000,
  maxRedirects: 5,
  maxBytes: 5 * 1024 * 1024,
  maxBodyChars: 100_000,
  maxExpandedBytes: 10 * 1024 * 1024,
  maxExpansionRatio: 100,
  maxPdfPages: 100,
  maxExtractMs: 10_000,
});

const blockedV4 = new BlockList();
const blockedV6 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
]) blockedV4.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 96], ["::1", 128], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64],
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20], ["5f00::", 16], ["fc00::", 7],
  ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
]) blockedV6.addSubnet(network, prefix, "ipv6");

const BLOCKED_METADATA_IPV4 = new Set(["100.100.100.200", "168.63.129.16"]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_CONCURRENT_DOCUMENT_EXTRACTORS = 2;
let activeDocumentExtractors = 0;
const SAFE_HTTP_LIMIT_CEILINGS = Object.freeze({
  maxUrlLength: 8_192,
  timeoutMs: 120_000,
  maxRedirects: 10,
  maxBytes: 20 * 1024 * 1024,
  maxBodyChars: 1_000_000,
  maxExpandedBytes: 20 * 1024 * 1024,
  maxExpansionRatio: 100,
  maxPdfPages: 500,
  maxExtractMs: 30_000,
});
const SAFE_HEADERS = Object.freeze({
  accept: "text/html,application/xhtml+xml,text/plain,application/json,application/xml,text/xml,application/pdf,application/gzip,application/x-gzip;q=0.9,*/*;q=0.1",
  "accept-encoding": "identity",
  "user-agent": "DeepSeek-Harness-WebFetch/1.0",
});

function webError(message, code, cause) {
  return new WebError(message, code, cause === undefined ? undefined : { cause });
}

export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) return !blockedV4.check(address, "ipv4") && !BLOCKED_METADATA_IPV4.has(address);
  if (family === 6) return !blockedV6.check(address, "ipv6");
  return false;
}

function parseSafeUrl(value, maxUrlLength) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxUrlLength) {
    throw webError("web fetch URL is empty or exceeds the configured length limit", "WEB_FETCH_INVALID_URL");
  }
  let url;
  try { url = new URL(value); } catch (cause) {
    throw webError("web fetch URL is invalid", "WEB_FETCH_INVALID_URL", cause);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw webError("web fetch permits only credential-free HTTP(S) URLs", "WEB_FETCH_INVALID_URL");
  }
  return url;
}

async function resolvePublicAddress(hostname, dnsLookup) {
  const host = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw webError("web fetch target address is not public", "WEB_FETCH_BLOCKED_URL");
    return { address: host, family: isIP(host) };
  }
  let answers;
  try { answers = await dnsLookup(host); } catch (cause) {
    throw webError("web fetch DNS resolution failed", "WEB_FETCH_DNS_ERROR", cause);
  }
  if (!Array.isArray(answers) || answers.length === 0) {
    throw webError("web fetch DNS resolution returned no addresses", "WEB_FETCH_DNS_ERROR");
  }
  const normalized = answers.map((answer) => typeof answer === "string"
    ? { address: answer, family: isIP(answer) }
    : { address: answer?.address, family: Number(answer?.family) || isIP(answer?.address) });
  if (normalized.some(({ address, family }) => !address || !family || !isPublicAddress(address))) {
    throw webError("web fetch DNS answer contains a non-public address", "WEB_FETCH_BLOCKED_URL");
  }
  return normalized[0];
}

function defaultDnsLookup(hostname) {
  return nodeLookup(hostname, { all: true, verbatim: true });
}

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export function pinnedLookup(address, family) {
  return (_hostname, lookupOptions, callback) => {
    if (lookupOptions?.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

function defaultTransport({ url, address, family, headers, signal }) {
  const client = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.request(url, {
      method: "GET",
      headers,
      signal,
      agent: false,
      lookup: pinnedLookup(address, family),
    }, resolve);
    request.once("error", reject);
    request.end();
  });
}

function discardBody(body) {
  if (!body) return;
  // Connections are intentionally not pooled (`agent: false`), so destroying a
  // redirect body is safer than draining an attacker-controlled response.
  if (typeof body.destroy === "function") body.destroy();
}

function responseHeader(response, name) {
  const value = response.headers?.[name] ?? response.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function bodyFormat(contentType) {
  const mediaType = String(contentType ?? "text/plain").split(";", 1)[0].trim().toLowerCase();
  if (mediaType === "text/html" || mediaType === "application/xhtml+xml") return { kind: "html", format: "text" };
  if (mediaType.startsWith("text/") || mediaType === "application/json" || mediaType.endsWith("+json") ||
      mediaType === "application/xml" || mediaType.endsWith("+xml") ||
      mediaType === "application/javascript" || mediaType === "application/x-javascript") return { kind: "text", format: "text" };
  if (mediaType === "application/pdf") return { kind: "text", format: "pdf" };
  if (mediaType === "application/gzip" || mediaType === "application/x-gzip") return { kind: "text", format: "gzip" };
  throw webError(`web fetch content type is unsupported: ${mediaType || "unknown"}`, "WEB_FETCH_UNSUPPORTED_CONTENT_TYPE");
}

async function readBody(response, limits, signal) {
  const onAbort = () => discardBody(response);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const rawDeclared = responseHeader(response, "content-length");
    const declared = rawDeclared === undefined ? undefined : Number(rawDeclared);
    if (declared !== undefined && Number.isFinite(declared) && declared > limits.maxBytes) {
      discardBody(response);
      throw webError("web fetch response exceeds the byte limit", "WEB_FETCH_TOO_LARGE");
    }
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > limits.maxBytes) {
        discardBody(response);
        throw webError("web fetch response exceeds the byte limit", "WEB_FETCH_TOO_LARGE");
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

function decodeTextBody(buffer, maxBodyChars) {
  let content;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (cause) {
    throw webError("web fetch text body is not valid UTF-8", "WEB_FETCH_INVALID_TEXT", cause);
  }
  const truncated = content.length > maxBodyChars;
  return { content: truncated ? content.slice(0, maxBodyChars) : content, truncated };
}

function defaultDocumentExtractor({ format, buffer, limits, signal }) {
  if (activeDocumentExtractors >= MAX_CONCURRENT_DOCUMENT_EXTRACTORS) {
    return Promise.reject(webError("web fetch document extractors are busy", "WEB_FETCH_EXTRACTION_BUSY"));
  }
  let worker;
  try {
    worker = new Worker(new URL("./document-extractor-worker.js", import.meta.url), {
      resourceLimits: {
        maxOldGenerationSizeMb: 256,
        maxYoungGenerationSizeMb: 64,
        stackSizeMb: 4,
      },
    });
  } catch (cause) {
    return Promise.reject(webError("web fetch document worker failed to start", "WEB_PROVIDER_ERROR", cause));
  }
  activeDocumentExtractors += 1;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      activeDocumentExtractors -= 1;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      void worker.terminate();
      callback(value);
    };
    const onAbort = () => finish(reject, signal.reason ?? webError("web fetch aborted", "WEB_ABORTED"));
    const timer = setTimeout(() => finish(reject, webError("web fetch document extraction timed out", "WEB_FETCH_EXTRACTION_TIMEOUT")), limits.maxExtractMs);
    timer.unref?.();
    worker.once("message", (message) => {
      if (message?.ok) finish(resolve, message.result);
      else finish(reject, webError(message?.message ?? "web fetch document extraction failed", message?.code ?? "WEB_PROVIDER_ERROR"));
    });
    worker.once("error", (error) => finish(reject, webError("web fetch document worker failed", "WEB_PROVIDER_ERROR", error)));
    worker.once("exit", (code) => {
      if (!settled && code !== 0) finish(reject, webError(`web fetch document worker exited with code ${code}`, "WEB_PROVIDER_ERROR"));
    });
    if (signal?.aborted) onAbort();
    else {
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const bytes = Uint8Array.from(buffer);
        worker.postMessage({ format, bytes, limits }, [bytes.buffer]);
      } catch (cause) {
        finish(reject, webError("web fetch document worker input failed", "WEB_PROVIDER_ERROR", cause));
      }
    }
  });
}

function resolveLimits(overrides) {
  const limits = { ...DEFAULT_SAFE_HTTP_LIMITS, ...(overrides ?? {}) };
  for (const [key, value] of Object.entries(limits)) {
    const minimum = key === "maxRedirects" ? 0 : 1;
    const maximum = SAFE_HTTP_LIMIT_CEILINGS[key];
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new Error(`safe-http-fetch: ${key} must be a safe integer from ${minimum} to ${maximum}`);
    }
  }
  return Object.freeze(limits);
}

/** Create an anonymous, DNS-pinned DSH WebFetchProvider. Injection options are test seams. */
export function createSafeHttpFetchProvider(options = {}) {
  const limits = resolveLimits(options.limits);
  const dnsLookup = options.dnsLookup ?? defaultDnsLookup;
  const transport = options.transport ?? defaultTransport;
  const documentExtractor = options.documentExtractor ?? defaultDocumentExtractor;
  return Object.freeze({
    id: SAFE_HTTP_FETCH_PROVIDER_ID,
    available() { return true; },
    async fetch(request, signal) {
      if (signal?.aborted) throw webError("web fetch aborted", "WEB_ABORTED", signal.reason);
      const timeoutController = new AbortController();
      const onAbort = () => timeoutController.abort(signal.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => timeoutController.abort(new Error("web fetch timed out")), limits.timeoutMs);
      timer.unref?.();
      let timedOut = false;
      const onTimeoutAbort = () => { timedOut = !signal?.aborted; };
      timeoutController.signal.addEventListener("abort", onTimeoutAbort, { once: true });
      try {
        let url = parseSafeUrl(request?.url, limits.maxUrlLength);
        for (let redirects = 0; ; redirects += 1) {
          const pinned = await abortable(resolvePublicAddress(url.hostname, dnsLookup), timeoutController.signal);
          let response;
          try {
            response = await transport({ url, ...pinned, headers: { ...SAFE_HEADERS }, signal: timeoutController.signal });
          } catch (cause) {
            if (timeoutController.signal.aborted) {
              throw webError(timedOut ? "web fetch timed out" : "web fetch aborted", timedOut ? "WEB_FETCH_TIMEOUT" : "WEB_ABORTED", cause);
            }
            throw webError("web fetch request failed", "WEB_PROVIDER_ERROR", cause);
          }
          const statusCode = Number(response.statusCode ?? response.status);
          const location = responseHeader(response, "location");
          if (REDIRECT_STATUSES.has(statusCode) && location) {
            discardBody(response);
            if (redirects >= limits.maxRedirects) throw webError("web fetch redirect limit exceeded", "WEB_FETCH_REDIRECT_LIMIT");
            let next;
            try { next = new URL(String(location), url); } catch (cause) {
              throw webError("web fetch redirect URL is invalid", "WEB_FETCH_INVALID_URL", cause);
            }
            url = parseSafeUrl(next.href, limits.maxUrlLength);
            continue;
          }
          const contentEncoding = String(responseHeader(response, "content-encoding") ?? "identity").trim().toLowerCase();
          if (contentEncoding !== "" && contentEncoding !== "identity") {
            discardBody(response);
            throw webError(`web fetch content encoding is unsupported: ${contentEncoding}`, "WEB_FETCH_UNSUPPORTED_CONTENT_TYPE");
          }
          let classification;
          try {
            classification = bodyFormat(responseHeader(response, "content-type"));
          } catch (error) {
            discardBody(response);
            throw error;
          }
          const buffer = await abortable(readBody(response, limits, timeoutController.signal), timeoutController.signal);
          const decoded = classification.format === "text"
            ? decodeTextBody(buffer, limits.maxBodyChars)
            : await abortable(documentExtractor({ format: classification.format, buffer, limits, signal: timeoutController.signal }), timeoutController.signal);
          return { url: url.href, statusCode, body: { kind: classification.kind, content: decoded.content }, truncated: decoded.truncated };
        }
      } catch (error) {
        if (error instanceof WebError) throw error;
        if (timeoutController.signal.aborted) {
          throw webError(timedOut ? "web fetch timed out" : "web fetch aborted", timedOut ? "WEB_FETCH_TIMEOUT" : "WEB_ABORTED", error);
        }
        throw webError("web fetch failed", "WEB_PROVIDER_ERROR", error);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  });
}

export const safeHttpFetchProvider = createSafeHttpFetchProvider();
