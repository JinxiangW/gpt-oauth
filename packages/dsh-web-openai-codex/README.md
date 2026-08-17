# dsh-web-openai-codex

Optional Codex Web Search and SSRF-safe HTTP Fetch for DeepSeek Harness. This is
the Web Provider companion to `dsh-llm-openai`; it consumes that package's
in-process OAuth transport and never reads or receives refresh tokens.

## Behavior

The **Codex Web** setting is a combined switch and defaults to off:

- Off: DSH keeps its preset-provided `web_search`; no `web_fetch` is added.
- On: the agent-local standard `web_search` tool is shadowed by a Codex-backed
  tool with the same schema/presentation, and the standard `web_fetch` tool is
  added.
- A switch requested during a running agent turn is applied when that agent next
  becomes idle.

Codex search inherits the current `openai-codex` session model, projects only the
recent two-user-message conversation tail, and fails when the API response has no
parseable HTTP(S) citation URLs. It never silently falls back to another model or
provider while enabled.

Safe Fetch accepts credential-free public HTTP(S) URLs only. It validates all DNS
answers, pins the socket to the validated address, repeats validation for every
redirect, rejects local/private/link-local/CGNAT/ULA/multicast/reserved/metadata
targets, and sends no cookies or OAuth credentials.

Supported response bodies are UTF-8 text/HTML/JSON/XML, PDF text extraction, and
one bounded `application/gzip` or `application/x-gzip` layer containing UTF-8
text or a PDF. PDF/gzip parsing runs in a terminating worker with compressed and
expanded byte limits, a 100-page default limit, character limits, a 100× expansion
ratio ceiling, and a 10-second extraction deadline. Archives, nested compression,
scanned/image-only PDFs, invalid UTF-8, and other binary formats fail explicitly.

## Settings

Open DSH Settings, select **llm-openai**, and edit its **codexWeb** group. DSH
only exposes configurable model-provider namespaces to the generic settings UI,
so the OAuth core owns this small configuration seam while all Web execution
stays in this independent package.

- `codexWeb.enabled` (default `false`)
- `codexWeb.searchMaxResults` (8)
- `codexWeb.searchTimeoutMs` (60000)
- `codexWeb.searchMaxOutputTokens` (4096)
- `codexWeb.assistantContextTokens` (1000)
- `codexWeb.fetchTimeoutMs` (60000)
- `codexWeb.fetchMaxResponseBytes` (5242880)
- `codexWeb.fetchMaxBodyChars` (100000)
- `codexWeb.fetchMaxRedirects` (5)
- `codexWeb.fetchMaxUrlLength` (2048)
- `codexWeb.fetchMaxOutputChars` (200000)

Changing settings does not require restarting DSH after the plugin has loaded.

## Composition

Load this package on the host plane after `dsh-llm-openai`:

```yaml
- insert:
    - id: web-openai-codex
      name: dsh-web-openai-codex
```

The plugin injects `agents`, `tools`, and `systemPrompt`. It resolves the
`openaiCodexTransport` service lazily when search executes, so composition order
does not decide whether the settings section can load; a missing OAuth package
still fails explicitly at tool execution. It does not modify an installed DSH
preset or `ctx.web` provider selection.

## Test

```powershell
npm run check
npm test
npm run smoke   # authenticated alpha/search + public/private Fetch checks
```

The smoke command refuses network/OAuth access unless `--live` is present (the
script used by `npm run smoke` includes it). It prints only status, source count,
content length, and stable error codes—never tokens or complete API payloads.
