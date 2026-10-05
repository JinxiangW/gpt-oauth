# dsh-llm-openai

ChatGPT-subscription login and GPT model adapter for current DeepSeek Harness
(`0.2.0-rc.2` architecture).

The plugin owns the `openai-codex` provider route (display name **OpenAI
(ChatGPT)**). ChatGPT OAuth credentials are sent only to the fixed ChatGPT
Codex backend (`/backend-api/codex/responses` for models and the allowlisted
`/backend-api/codex/alpha/search` companion transport), never to a configurable
third-party gateway.

## Models

The model list follows pi-ai's installed OpenAI Codex catalog, with a GPT-6.1 Sol
catalog backport for the current Desktop runtime. `@earendil-works/pi-ai`
is a **peer** dependency pinned to the `^0.87.1` line, which is the version the
DSH `0.2.0-rc.2` runtime itself bundles; the plugin therefore shares the host's
pi-ai instance instead of loading a second copy with its own provider contract.
That range is what the current catalog requires:

- GPT-6 (`gpt-6-astra`, `gpt-6-luna`, `gpt-6-sol`) first appears in pi-ai
  `0.85.1`/`0.87.1`; `0.82.1`-`0.84.x` stop at `gpt-5.6`.
- pi-ai `0.86` dropped `gpt-5.4` and `gpt-5.4-mini`, so those ids are gone.
- pi-ai `0.99.x` adds `gpt-6.1-sol`. `codex-catalog.mjs` backports its `0.99.2`
  subscription descriptor without replacing the Harness's shared pi-ai runtime.
  If the host later supplies the same id, its descriptor takes precedence.

With `0.87.1` the resolved catalog is:

- `gpt-5.5`
- `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`
- `gpt-6-astra`, `gpt-6-luna`, `gpt-6-sol`
- `gpt-6.1-sol` (catalog backport; Standard and Fast)

GPT-5.3 Codex Spark is filtered out because it retired from ChatGPT subscription
Codex on September 14, 2026. The shared catalog still contains its historical
descriptor. Reasoning selectors retain each model's upstream capabilities,
including GPT-6 Max and Astra's prohibition on `off`.

GPT-6.1 Sol offers `low`, `medium`, `high`, `xhigh`, and `max` reasoning. It does
not offer `off`/`none` or `minimal`, matching the
[OpenAI model documentation](https://developers.openai.com/api/docs/models/gpt-6.1-sol).
The backport retains pi-ai's subscription context limit of 272,000 tokens and
128,000 output tokens. Model visibility does not guarantee account access;
the ChatGPT backend enforces the account's model and speed entitlements.

Models in `FAST_MODEL_IDS` also receive `-fast` selector variants: same wire model
with `service_tier: priority` (pi-ai applies the priority cost multiplier and
falls back to default pricing when the backend does not honor the tier).
Image-capable models use DSH's durable attachment service. Sync `FAST_MODEL_IDS`
in `index.js` when the pi-ai catalog changes: pi-ai exposes no per-model
priority-tier capability.

## Current DSH architecture

Version 0.4 migrates the plugin to the `0.2.0-rc.2` Harness contracts:

- `PiAiAdapter` receives the required durable `auth` injection.
- OAuth grants and refresh rotation use `ctx.credentials` record
  `llm-openai/openai-codex`, including its serialized cross-process mutation.
- The plugin registers a ChatGPT browser/device authorization flow when
  `ctx.authorization` is mounted.
- A legacy `~/.dsh/openai-oauth.json` login is migrated once into
  `~/.dsh/.credentials.yaml`. Until migration succeeds it remains a compatible
  read fallback.
- `0.2` replaced `settings.yaml` sections with per-Loader-entry config, so the
  plugin no longer calls `installSettingsSection`; the entry's `config:` row is
  the settings surface and the namespace `llm-openai/openai-codex` is reported
  to `ctx.llm.registerConfigurableProviders` for the Models page.
- `0.2` also moved `defineTool` to `@deepseek-ai/dsh-tools`, which is where the
  Web package imports it.
- `@earendil-works/pi-ai` moved from a pinned `0.82.1` dependency to the
  `^0.87.1` peer range so the host runtime supplies the instance (see Models).

The shipped `cordis.patch.yml` is a DSH profile bundle that mounts the adapter
and reuses the `authorization` seam from `dsh-base`. Do not configure the generic
`llm-pi-ai` plugin's own `openai-codex` route at the same time; both would claim
the same LLM route.

## Install

Install the LLM and Web-provider bundles into a profile. `dsh plugin` forwards
to pnpm and reconciles `dsh.profile.bundles` from the installed state:

```powershell
dsh plugin --profile web add dsh-llm-openai
dsh plugin --profile web add dsh-web-openai-codex
```

The `desktop` profile is managed exclusively by the Electron application, which
rejects `dsh plugin --profile desktop`; there the two bundles are declared in
`~/.dsh/profiles/desktop/package.json` and linked into its `node_modules` as
junctions to this checkout. `dsh-web-openai-codex` is always linked rather than
copied, because a `file:` dependency is materialized as a snapshot copy and would
go stale on every source edit.

For this monorepo checkout, the second package lives under
`packages/dsh-web-openai-codex`. A development convenience linker is also
provided:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\link-to-dsh.ps1
```

After changing a Host plugin or profile composition, restart `dsh web`. These
packages do not ship a browser client bundle, so the DSH client-plugin HMR
watcher is not involved.

## Login

```powershell
dsh-openai-login          # browser callback login
dsh-openai-login --device # device-code login
```

The standalone command writes the plugin-owned grant record directly to
`~/.dsh/.credentials.yaml`. OAuth refreshes happen through DSH's per-record
mutation lock. A pre-0.3 `~/.dsh/openai-oauth.json` file is still imported once
and removed during plugin activation.

The registered `ctx.authorization` flow uses the same browser and device
protocols for surfaces that expose the authorization seam. Current stock DSH
`0.2.0-rc.2` exposes API-key reference editing but does not yet expose grant
records over its public browser RPC, so `dsh-openai-login` remains the supported
Web-profile login entry point.

## Codex Web companion

`dsh-web-openai-codex` follows the standard Web architecture:

- registers search provider `openai-codex` on `ctx.web`;
- lets `@deepseek-ai/dsh-tool-web` own model-facing schemas, formatting,
  multi-query execution, and presentation;
- obtains only the short-lived access token through the LLM plugin's in-process
  allowlisted transport; refresh tokens never reach the Web package.

Its bundle selects the search provider in the host `web` service. Search works
for any session model: on an `openai-codex` session it inherits the session model
and a bounded conversation tail, while on any other session model it uses the
configured `searchModel` (default `gpt-5.4`) and sends the query alone, so a
non-GPT conversation is never uploaded to the ChatGPT backend. On a pi-ai
`0.86`+ catalog `gpt-5.4` is no longer a chat model, but it remains a valid
alpha/search wire id; set `searchModel: gpt-6-luna` to use the current
generation (see Enable GPT web search in a profile).

The package still exports `createSafeHttpFetchProvider` (SSRF-safe Fetch:
validates DNS and every redirect, pins the validated address, blocks private and
metadata ranges, sends no ambient credentials, and bounds text/PDF/gzip work).
It is deliberately not registered by `apply()`: stock DSH mounts no fetch
provider, so enabling it is a separate composition decision.

## Enable GPT web search in a profile

Search is a host `web`-row selection, so a profile needs both bundles and one
config row. The `desktop` profile (the Electron app) uses junctions to this
checkout plus this patch layer:

```yaml
# ~/.dsh/profiles/desktop/cordis.patch.yml
- id: web
  config:
    searchProvider: openai-codex

- id: web-openai-codex
  name: dsh-web-openai-codex
  config:
    searchModel: gpt-6-luna
```

`searchModel` only decides the wire model when the session model is not
`openai-codex`; a `-fast` suffix is accepted and stripped. Restart the
application after changing the composition, then confirm the loaded rows in the
Settings plugin inventory and run one `web_search`.

## Proxy behavior

The plugin reads `DSH_OPENAI_PROXY`, `OPENAI_PROXY`, standard HTTP(S) proxy
environment variables, `NO_PROXY`, and Windows WinINet proxy settings. Proxying
is scoped to OpenAI OAuth and Codex requests. Invalid explicit proxy settings
fail closed. When a proxy is active, model transport uses SSE so a WebSocket
cannot bypass it.

## Verify

```powershell
npm run check
npm test
node .\smoke-test.mjs --no-call
node .\smoke-test.mjs --model=gpt-5.6-luna # authenticated network smoke
```

The offline suites cover OAuth record adaptation, callback cancellation,
security boundaries, model transport, DSH adapter behavior, standard Web
provider mapping, DNS pinning, PDF/gzip bounds, and legacy API compatibility.
