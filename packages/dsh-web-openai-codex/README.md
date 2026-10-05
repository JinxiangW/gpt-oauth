# dsh-web-openai-codex

Codex OAuth Search (and optional SSRF-safe Fetch) provider for the current
DeepSeek Harness Web seam. This is the Host Web-provider companion to
`dsh-llm-openai`; it is not a browser client plugin and never receives refresh
tokens.

## Current architecture

Version 0.3 targets the `0.2.0-rc.2` Harness contracts:

- Search provider id: `openai-codex`
- Fetch provider id: `openai-codex-safe-http` (exported, not registered)
- Provider registry: `ctx.web`
- Model-facing tools: `@deepseek-ai/dsh-tool-web` (the package that owns them)
- Tool construction: `defineTool` from `@deepseek-ai/dsh-tools`, which is where
  `0.2` moved it (it was re-exported by `dsh-tool-web` in `0.1.1`)

`apply()` registers the search provider only. Search therefore gains the current
standard DSH schema, concurrent multi-query execution, formatting, structured
errors, presentation, and lifecycle instead of maintaining a private copy of the
tool.

The bundle preserves DSH's built-in `http` fetch provider. `apply()` does not
register Safe Fetch; the provider factory stays exported for a composition that wants it. The
older `createAgentWebToggle` export remains as a compatibility shim for 0.1.x
API consumers but is no longer used by the plugin.

## Codex search

Search runs on GPT regardless of which model the session uses:

- when the session model already is `openai-codex`, search inherits that model,
  normalizes `-fast` to the wire model, and projects a bounded recent
  conversation tail;
- with any other session model (for example DeepSeek), search uses the
  configured `searchModel` and **omits the conversation entirely**, so a
  non-Codex conversation is never uploaded to the ChatGPT backend. The built-in
  default is `gpt-6-luna`.

A missing initiating agent, missing OAuth transport, unusable `searchModel`, or
source-less response fails explicitly; it never silently falls back to another
provider.

The short-lived access token is resolved at execution through the allowlisted
`openaiCodexTransport` service owned by `dsh-llm-openai`. The Web package does
not read credentials or refresh tokens.

## Safe Fetch

Safe Fetch accepts credential-free public HTTP(S) URLs only. It validates all
DNS answers, pins the socket to the validated address, repeats validation for
every redirect, rejects local/private/link-local/CGNAT/ULA/multicast/reserved
and metadata targets, and sends no cookies or OAuth credentials.

Supported bodies are UTF-8 text/HTML/JSON/XML, PDF text extraction, and one
bounded gzip layer containing UTF-8 text or PDF. Document processing runs in a
terminating worker with byte/page/character/ratio/deadline limits. Nested
compression, invalid UTF-8, scanned PDFs, archives, and other binary formats
fail explicitly.

## Configuration

The Loader row's `config:` is the settings surface; a changed row remounts the
plugin. `0.2` removed `settings.yaml` sections, so there is no
`installSettingsSection` call and no separate namespace file:

```yaml
- id: web-openai-codex
  name: dsh-web-openai-codex
  config:
    searchModel: gpt-6-luna
    searchMaxOutputTokens: 4096
    assistantContextTokens: 1000
```

`searchModel` is the GPT wire model used when the session model is not
`openai-codex`; a `-fast` suffix is stripped like the session model is.

Provider selection belongs to the host `web` row:

```yaml
- id: web
  config:
    searchProvider: openai-codex
```

## Install

```powershell
dsh plugin --profile web add dsh-llm-openai
dsh plugin --profile web add dsh-web-openai-codex
```

The `desktop` profile is application-managed and rejects `dsh plugin --profile
desktop`; there the bundles are declared in the profile manifest and linked as
junctions. Restart the host after composition or plugin changes. This package has
no `dsh.client` face and therefore does not use client-plugin HMR.

## Test

```powershell
npm run check
npm test
npm run smoke # authenticated search + public/private fetch checks
```

The smoke command refuses OAuth/network traffic unless `--live` is explicit.
It never prints tokens or complete API payloads.
