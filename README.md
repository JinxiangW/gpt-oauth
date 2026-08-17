# dsh-llm-openai

ChatGPT-subscription login and GPT model adapter for `dsh`.

The plugin owns the `openai-codex` provider route (display name: **OpenAI
(ChatGPT)**). ChatGPT OAuth credentials are sent only to
`https://chatgpt.com/backend-api/codex/responses`, not to the regular API-key
platform endpoint or a configurable third-party gateway.

## What it exposes

Subscription-supported GPT models (current pi-ai/opencode catalog):

- `gpt-5.3-codex-spark`: off/low/medium/high/xhigh
- `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5`: off/low/medium/high/xhigh
- `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`: off/low/medium/high/xhigh/max

Fast variants use the same wire model with `service_tier: priority`:

- `gpt-5.4-fast`, `gpt-5.4-mini-fast`, `gpt-5.5-fast`
- `gpt-5.6-luna-fast`, `gpt-5.6-sol-fast`, `gpt-5.6-terra-fast`

Models that advertise image input use DSH's durable attachment service.

## Install

### npm package or tarball

After publication, or from a locally built tarball:

```powershell
npm install dsh-llm-openai
# npm install .\dsh-llm-openai-0.2.0.tgz
```

The package installs the cross-platform `dsh-openai-login` command and declares
all runtime and DSH peer dependencies.

### Development checkout on Windows

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\link-to-dsh.ps1
```

The linker points the checkout at the current DSH profile dependencies and
installs a Windows login shim. It deliberately refuses to replace any existing
directory, unexpected link, or unrelated command. A development checkout that
uses this junction workflow also needs `undici` available either as its normal
package dependency or in the legacy `vendor` fallback.

## Login

```powershell
dsh-openai-login          # browser login
dsh-openai-login --device # device-code login
```

Credentials are stored atomically in `~/.dsh/openai-oauth.json`. If opencode is
already logged in with ChatGPT, the plugin may use a still-valid opencode access
token as a **read-only** fallback. It never refreshes or rewrites opencode's
shared auth file; run `dsh-openai-login` when that fallback is near expiry.

Run `dsh web` and select **OpenAI (ChatGPT)** in the model selector.

## Proxy behavior

The plugin reads `DSH_OPENAI_PROXY`, `OPENAI_PROXY`, standard HTTP(S) proxy
environment variables, `NO_PROXY`, and Windows WinINet proxy settings. Proxying
is scoped to this plugin's OAuth and Codex requests; it does not route unrelated
DSH fetches. Invalid explicit proxy configuration fails closed instead of
silently connecting directly. When a proxy is active, Codex uses SSE so a
WebSocket cannot bypass the proxy.

## Test

```powershell
npm run check
npm test                                  # offline regression suite
node .\smoke-test.mjs --no-call           # catalog only; no credential/network
node .\smoke-test.mjs                     # real API: gpt-5.4-mini, all efforts
node .\smoke-test.mjs --model=gpt-5.6-luna
```

A requested API case that throws or returns an error makes the smoke test exit
nonzero.
