import { parentPort } from "node:worker_threads";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";

const gunzipAsync = promisify(gunzip);
const PDF_MAGIC = Buffer.from("%PDF-");

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function startsWithPdf(buffer) {
  let offset = 0;
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) offset = 3;
  while (offset < buffer.length && (buffer[offset] === 0x09 || buffer[offset] === 0x0a || buffer[offset] === 0x0d || buffer[offset] === 0x20)) offset += 1;
  return buffer.subarray(offset, offset + PDF_MAGIC.length).equals(PDF_MAGIC);
}

function decodeBoundedText(buffer, maxBodyChars) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (cause) {
    throw failure("WEB_FETCH_GZIP_BINARY_UNSUPPORTED", `gzip payload is not valid UTF-8 text: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (text.includes("\0")) throw failure("WEB_FETCH_GZIP_BINARY_UNSUPPORTED", "gzip text payload contains NUL bytes");
  let controls = 0;
  const sampleLength = Math.min(text.length, 4096);
  for (let index = 0; index < sampleLength; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) controls += 1;
  }
  if (sampleLength > 0 && controls / sampleLength > 0.01) {
    throw failure("WEB_FETCH_GZIP_BINARY_UNSUPPORTED", "gzip payload appears to contain binary data");
  }
  const truncated = text.length > maxBodyChars;
  return { content: truncated ? text.slice(0, maxBodyChars) : text, truncated };
}

async function extractPdf(buffer, limits) {
  if (!startsWithPdf(buffer)) throw failure("WEB_FETCH_INVALID_PDF", "PDF payload does not have a valid PDF header");
  const { getDocumentProxy } = await import("unpdf");
  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(buffer), {
      isEvalSupported: false,
      useSystemFonts: false,
      disableFontFace: true,
      stopAtErrors: true,
      maxImageSize: 4_000_000,
      verbosity: 0,
    });
    if (!Number.isSafeInteger(pdf.numPages) || pdf.numPages < 1) {
      throw failure("WEB_FETCH_INVALID_PDF", "PDF has no readable pages");
    }
    if (pdf.numPages > limits.maxPdfPages) {
      throw failure("WEB_FETCH_PDF_PAGE_LIMIT", `PDF has ${pdf.numPages} pages; limit is ${limits.maxPdfPages}`);
    }
    let content = "";
    let truncated = false;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      let page;
      try {
        page = await pdf.getPage(pageNumber);
        const textContent = await page.getTextContent({ disableNormalization: false });
        const parts = [];
        for (const item of textContent.items ?? []) {
          if (typeof item?.str !== "string" || item.str.length === 0) continue;
          parts.push(item.str);
          if (item.hasEOL) parts.push("\n");
          else parts.push(" ");
        }
        const pageText = parts.join("").replace(/[ \t]+\n/g, "\n").trim();
        if (pageText.length > 0) {
          const prefix = content.length === 0 ? "" : "\n\n";
          const remaining = limits.maxBodyChars - content.length;
          const addition = `${prefix}${pageText}`;
          if (addition.length > remaining) {
            content += addition.slice(0, Math.max(0, remaining));
            truncated = true;
            break;
          }
          content += addition;
        }
      } finally {
        page?.cleanup?.();
      }
    }
    if (content.trim().length === 0) {
      throw failure("WEB_FETCH_PDF_NO_TEXT", "PDF contains no extractable text (it may be scanned or image-only)");
    }
    return { content, truncated };
  } catch (error) {
    if (typeof error?.code === "string" && error.code.startsWith("WEB_FETCH_")) throw error;
    throw failure("WEB_FETCH_INVALID_PDF", `PDF text extraction failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await pdf?.destroy?.();
  }
}

async function run({ format, bytes, limits }) {
  let buffer = Buffer.from(bytes);
  if (format === "gzip") {
    if (buffer.length < 3 || buffer[0] !== 0x1f || buffer[1] !== 0x8b || buffer[2] !== 0x08) {
      throw failure("WEB_FETCH_INVALID_GZIP", "gzip payload has an invalid header");
    }
    const ratioLimit = buffer.length * limits.maxExpansionRatio + 64 * 1024;
    const maxOutputLength = Math.min(limits.maxExpandedBytes, ratioLimit);
    try {
      buffer = await gunzipAsync(buffer, { maxOutputLength });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const limitHit = /maxOutputLength|larger than|too large|buffer/i.test(message);
      throw failure(limitHit ? "WEB_FETCH_EXPANSION_LIMIT" : "WEB_FETCH_INVALID_GZIP", limitHit ? "gzip payload exceeds the expansion limit" : `gzip decompression failed: ${message}`);
    }
    if (startsWithPdf(buffer)) return { ...(await extractPdf(buffer, limits)), format: "pdf" };
    return { ...decodeBoundedText(buffer, limits.maxBodyChars), format: "text" };
  }
  if (format === "pdf") return { ...(await extractPdf(buffer, limits)), format: "pdf" };
  throw failure("WEB_FETCH_UNSUPPORTED_CONTENT_TYPE", `unsupported extraction format: ${format}`);
}

parentPort?.once("message", async (message) => {
  try {
    const result = await run(message);
    parentPort.postMessage({ ok: true, result });
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      code: typeof error?.code === "string" ? error.code : "WEB_PROVIDER_ERROR",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
