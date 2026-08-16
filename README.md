# dsh-llm-openai

ChatGPT-subscription login and GPT model adapter for `dsh`.

The plugin owns the `openai-codex` provider route (display name: **OpenAI
(ChatGPT)**). It follows opencode's behavior: ChatGPT OAuth credentials are
used against `https://chatgpt.com/backend-api/codex/responses`, not the
regular API-key platform endpoint.

## What it exposes

Subscription-supported GPT models (current pi-ai/opencode catalog):

- `gpt-5.3-codex-spark`: off/low/medium/high/xhigh
- `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5`: off/low/medium/high/xhigh
- `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`: off/low/medium/high/xhigh/max

Fast variants (same wire model with `service_tier: priority`, matching
opencode's `-fast` model entries):

- `gpt-5.4-fast`, `gpt-5.4-mini-fast`, `gpt-5.5-fast`
- `gpt-5.6-luna-fast`, `gpt-5.6-sol-fast`, `gpt-5.6-terra-fast`

## Files

- `index.js` — dsh plugin.
- `login.mjs` — browser or device-code ChatGPT OAuth login; stores `~/.dsh/openai-oauth.json`.
- `proxy.mjs` — Node fetch proxy support. Reads `DSH_OPENAI_PROXY`, `HTTPS_PROXY`, or Windows system proxy.
- `smoke-test.mjs` — catalog/token/API smoke test.
- `link-to-dsh.ps1` — junctions this directory into the dsh web profile.

## Install

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\link-to-dsh.ps1
npm install --prefix vendor undici@6.21.2 --no-audit --no-fund
```

`dsh-openai-login.cmd` is installed in `%APPDATA%\npm`.

## Login

```powershell
dsh-openai-login          # browser login
dsh-openai-login --device # device-code login
```

If opencode is already logged in with ChatGPT, dsh reuses and refreshes that
credential automatically. Run `dsh web` and pick **OpenAI (ChatGPT)** in the
model selector.

## Test

```powershell
node .\smoke-test.mjs                    # gpt-5.4-mini, all supported efforts
node .\smoke-test.mjs --model=gpt-5.6-luna
node .\smoke-test.mjs --no-call         # catalog only, no API calls
```
