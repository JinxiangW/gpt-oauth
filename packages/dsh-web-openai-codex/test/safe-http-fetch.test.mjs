import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { gzipSync } from "node:zlib";

import {
  SAFE_HTTP_FETCH_PROVIDER_ID,
  createSafeHttpFetchProvider,
  isPublicAddress,
  pinnedLookup,
} from "../lib/safe-http-fetch.js";

function response(statusCode, body = "", headers = { "content-type": "text/plain" }) {
  const stream = Readable.from([Buffer.from(body)]);
  stream.statusCode = statusCode;
  stream.headers = headers;
  return stream;
}

function simplePdf(text = "Hello PDF") {
  const escaped = text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(`BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`)} >>\nstream\nBT /F1 12 Tf 72 720 Td (${escaped}) Tj ET\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body);
}

function setup({ answers = [{ address: "93.184.216.34", family: 4 }], replies = [], limits, documentExtractor } = {}) {
  const dnsCalls = [];
  const transportCalls = [];
  let replyIndex = 0;
  const provider = createSafeHttpFetchProvider({
    limits,
    documentExtractor,
    async dnsLookup(hostname) {
      dnsCalls.push(hostname);
      return typeof answers === "function" ? answers(hostname) : answers;
    },
    async transport(call) {
      transportCalls.push(call);
      const item = replies[replyIndex++] ?? response(200, "ok");
      return typeof item === "function" ? item(call) : item;
    },
  });
  return { provider, dnsCalls, transportCalls };
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (error) => error?.code === code, code);
}

test("pinned lookup supports Node single-address and all-address contracts", () => {
  const lookup = pinnedLookup("93.184.216.34", 4);
  lookup("example.com", {}, (error, address, family) => {
    assert.equal(error, null);
    assert.equal(address, "93.184.216.34");
    assert.equal(family, 4);
  });
  lookup("example.com", { all: true }, (error, addresses) => {
    assert.equal(error, null);
    assert.deepEqual(addresses, [{ address: "93.184.216.34", family: 4 }]);
  });
});

test("provider rejects unsafe or non-integral limits at construction", () => {
  assert.throws(() => createSafeHttpFetchProvider({ limits: { maxBytes: 1.5 } }), /safe integer/);
  assert.throws(() => createSafeHttpFetchProvider({ limits: { maxRedirects: -1 } }), /safe integer/);
  assert.throws(() => createSafeHttpFetchProvider({ limits: { timeoutMs: 120_001 } }), /safe integer/);
});

test("provider has the DSH WebFetchProvider shape", async () => {
  const { provider } = setup();
  assert.equal(provider.id, SAFE_HTTP_FETCH_PROVIDER_ID);
  assert.equal(provider.id, "openai-codex-safe-http");
  assert.equal(provider.available(), true);
  const result = await provider.fetch({ url: "https://example.com/a" });
  assert.deepEqual(result, {
    url: "https://example.com/a",
    statusCode: 200,
    body: { kind: "text", content: "ok" },
    truncated: false,
  });
});

test("extracts text from PDF responses in a bounded worker", async () => {
  const { provider } = setup({ replies: [response(200, simplePdf("Disney BRDF notes"), { "content-type": "application/pdf" })] });
  const result = await provider.fetch({ url: "https://example.com/paper.pdf" });
  assert.equal(result.body.kind, "text");
  assert.match(result.body.content, /Disney BRDF notes/);
  assert.equal(result.truncated, false);
});

test("decodes gzip text and gzip-wrapped PDF resources", async () => {
  const textFixture = setup({ replies: [response(200, gzipSync("plain gzip notes"), { "content-type": "application/x-gzip" })] });
  const textResult = await textFixture.provider.fetch({ url: "https://example.com/notes.gz" });
  assert.deepEqual(textResult.body, { kind: "text", content: "plain gzip notes" });

  const pdfFixture = setup({ replies: [response(200, gzipSync(simplePdf("Compressed PDF")), { "content-type": "application/gzip" })] });
  const pdfResult = await pdfFixture.provider.fetch({ url: "https://example.com/paper.pdf.gz" });
  assert.equal(pdfResult.body.kind, "text");
  assert.match(pdfResult.body.content, /Compressed PDF/);
});

test("rejects corrupt, binary, and over-expanded gzip resources", async () => {
  const corrupt = setup({ replies: [response(200, "not gzip", { "content-type": "application/x-gzip" })] });
  await rejectsCode(corrupt.provider.fetch({ url: "https://example.com/bad.gz" }), "WEB_FETCH_INVALID_GZIP");

  const binary = setup({ replies: [response(200, gzipSync(Buffer.from([0, 1, 2, 3])), { "content-type": "application/gzip" })] });
  await rejectsCode(binary.provider.fetch({ url: "https://example.com/binary.gz" }), "WEB_FETCH_GZIP_BINARY_UNSUPPORTED");

  const expanded = setup({
    limits: { maxExpandedBytes: 1_000 },
    replies: [response(200, gzipSync("x".repeat(200_000)), { "content-type": "application/gzip" })],
  });
  await rejectsCode(expanded.provider.fetch({ url: "https://example.com/bomb.gz" }), "WEB_FETCH_EXPANSION_LIMIT");
});

test("maps document extractor timeout and supports an injected extractor seam", async () => {
  const fixture = setup({
    replies: [response(200, simplePdf(), { "content-type": "application/pdf" })],
    documentExtractor: async ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
    limits: { timeoutMs: 5 },
  });
  await rejectsCode(fixture.provider.fetch({ url: "https://example.com/hang.pdf" }), "WEB_FETCH_TIMEOUT");
});

test("rejects non-HTTP URLs, URL credentials, and oversized URLs", async () => {
  const { provider } = setup({ limits: { maxUrlLength: 30 } });
  await rejectsCode(provider.fetch({ url: "file:///etc/passwd" }), "WEB_FETCH_INVALID_URL");
  await rejectsCode(provider.fetch({ url: "https://user:pass@example.com" }), "WEB_FETCH_INVALID_URL");
  await rejectsCode(provider.fetch({ url: `https://example.com/${"x".repeat(40)}` }), "WEB_FETCH_INVALID_URL");
});

test("address policy blocks private, loopback, link-local, CGNAT, metadata, ULA, multicast, and reserved ranges", () => {
  for (const address of [
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "100.100.100.200", "168.63.129.16", "224.0.0.1", "240.0.0.1",
    "192.0.2.1", "198.51.100.1", "203.0.113.1", "::1", "fc00::1", "fe80::1", "ff02::1",
    "2001:db8::1", "::ffff:127.0.0.1",
  ]) assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress("93.184.216.34"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
});

test("rejects bracketed private IPv6 literals before DNS or transport", async () => {
  const { provider, dnsCalls, transportCalls } = setup();
  await rejectsCode(provider.fetch({ url: "http://[::1]/" }), "WEB_FETCH_BLOCKED_URL");
  assert.equal(dnsCalls.length, 0);
  assert.equal(transportCalls.length, 0);
});

test("rejects any mixed public/private DNS answer before transport", async () => {
  const { provider, transportCalls } = setup({ answers: [
    { address: "93.184.216.34", family: 4 },
    { address: "127.0.0.1", family: 4 },
  ] });
  await rejectsCode(provider.fetch({ url: "https://example.com" }), "WEB_FETCH_BLOCKED_URL");
  assert.equal(transportCalls.length, 0);
});

test("pins transport to the validated address and sends no ambient credentials", async () => {
  const { provider, transportCalls } = setup();
  await provider.fetch({ url: "https://example.com/path" });
  assert.equal(transportCalls[0].address, "93.184.216.34");
  assert.equal(transportCalls[0].family, 4);
  assert.equal(transportCalls[0].url.hostname, "example.com");
  assert.equal(transportCalls[0].headers.authorization, undefined);
  assert.equal(transportCalls[0].headers.cookie, undefined);
  assert.equal(transportCalls[0].headers["proxy-authorization"], undefined);
});

test("revalidates and pins every redirect target", async () => {
  const { provider, dnsCalls, transportCalls } = setup({
    answers(hostname) {
      return [{ address: hostname === "one.example" ? "93.184.216.34" : "1.1.1.1", family: 4 }];
    },
    replies: [
      response(302, "redirect", { location: "https://two.example/final", "content-type": "text/plain" }),
      response(200, "<h1>done</h1>", { "content-type": "text/html; charset=utf-8" }),
    ],
  });
  const result = await provider.fetch({ url: "https://one.example/start" });
  assert.deepEqual(dnsCalls, ["one.example", "two.example"]);
  assert.deepEqual(transportCalls.map((call) => call.address), ["93.184.216.34", "1.1.1.1"]);
  assert.equal(result.url, "https://two.example/final");
  assert.equal(result.body.kind, "html");
});

test("blocks a redirect whose fresh DNS answer is private", async () => {
  const { provider, transportCalls } = setup({
    answers(hostname) {
      return [{ address: hostname === "public.example" ? "93.184.216.34" : "169.254.169.254", family: 4 }];
    },
    replies: [response(302, "", { location: "http://metadata.example/latest" })],
  });
  await rejectsCode(provider.fetch({ url: "https://public.example" }), "WEB_FETCH_BLOCKED_URL");
  assert.equal(transportCalls.length, 1);
});

test("enforces redirect, byte, and decoded character limits", async () => {
  const redirect = setup({
    limits: { maxRedirects: 0 },
    replies: [response(302, "", { location: "/again" })],
  });
  await rejectsCode(redirect.provider.fetch({ url: "https://example.com" }), "WEB_FETCH_REDIRECT_LIMIT");

  const declaredResponse = response(200, "x", { "content-type": "text/plain", "content-length": "4" });
  const declared = setup({ limits: { maxBytes: 3 }, replies: [declaredResponse] });
  await rejectsCode(declared.provider.fetch({ url: "https://example.com" }), "WEB_FETCH_TOO_LARGE");
  assert.equal(declaredResponse.destroyed, true);

  const streamedResponse = response(200, "four");
  const streamed = setup({ limits: { maxBytes: 3 }, replies: [streamedResponse] });
  await rejectsCode(streamed.provider.fetch({ url: "https://example.com" }), "WEB_FETCH_TOO_LARGE");
  assert.equal(streamedResponse.destroyed, true);

  const chars = setup({ limits: { maxBodyChars: 3 }, replies: [response(200, "abcdef")] });
  assert.deepEqual(await chars.provider.fetch({ url: "https://example.com" }), {
    url: "https://example.com/", statusCode: 200,
    body: { kind: "text", content: "abc" }, truncated: true,
  });
});

test("returns non-2xx text results and rejects binary content", async () => {
  const text = setup({ replies: [response(404, "missing", { "content-type": "application/json" })] });
  const result = await text.provider.fetch({ url: "https://example.com/nope" });
  assert.equal(result.statusCode, 404);
  assert.deepEqual(result.body, { kind: "text", content: "missing" });

  const binaryResponse = response(200, "png", { "content-type": "image/png" });
  const binary = setup({ replies: [binaryResponse] });
  await rejectsCode(binary.provider.fetch({ url: "https://example.com/a.png" }), "WEB_FETCH_UNSUPPORTED_CONTENT_TYPE");
  assert.equal(binaryResponse.destroyed, true);

  const encodedResponse = response(200, "compressed", {
    "content-type": "text/plain",
    "content-encoding": "gzip",
  });
  const encoded = setup({ replies: [encodedResponse] });
  await rejectsCode(encoded.provider.fetch({ url: "https://example.com/a.txt" }), "WEB_FETCH_UNSUPPORTED_CONTENT_TYPE");
  assert.equal(encodedResponse.destroyed, true);
});

test("honors caller cancellation", async () => {
  const { provider } = setup({ replies: [({ signal }) => new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  })] });
  const controller = new AbortController();
  const pending = provider.fetch({ url: "https://example.com" }, controller.signal);
  controller.abort(new Error("stop"));
  await rejectsCode(pending, "WEB_ABORTED");
});

test("enforces its own timeout", async () => {
  const { provider } = setup({
    limits: { timeoutMs: 5 },
    replies: [({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })],
  });
  await rejectsCode(provider.fetch({ url: "https://example.com" }), "WEB_FETCH_TIMEOUT");
});
