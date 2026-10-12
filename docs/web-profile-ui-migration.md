# Web UI profile migration for DSH 0.2.0-rc.2

This optional profile migration replaces `@linxin666/dsh-web-ui-all@0.1.7` with
`@linxin666/dsh-web-all@0.4.6`. The retired components require `^0.1.0-rc.6` and
are correctly rejected by DSH `0.2.0-rc.2`. Do not bypass compatibility admission
or merely relax peer ranges: the older packages also use removed APIs.

These are profile-installation patches, **not** changes to the OpenAI provider
or a new npm release. They are not applied automatically when cloning this
repository. Recheck them before changing the aggregate, family or host version.

## Scope

| Feature | Replacement, under `@linxin666/` |
| --- | --- |
| Task board | `dsh-client-ui-task-board@0.4.6` |
| Git graph | `dsh-client-ui-git-graph@0.4.6` |
| Pet | `dsh-pet@0.4.6` |
| Remote web UI | `dsh-remote-web-ui@0.4.6` |
| SSH | `dsh-ssh@0.4.6`, explicitly enabled in the profile |
| Web UI settings | `dsh-client-ui-web-ui-settings@0.4.6` |
| Skins | `dsh-client-ui-skin-center@0.4.6`, patched for profile isolation |

AionUi and live TPS are intentionally excluded from this migration. The current
aggregate does not provide those panels. `dsh-usage` is not a verified live-TPS
replacement. Skill explorer retains its disabled default. The aggregate also
selects other publisher-provided families; it is not a seven-package bundle.

## Installation checklist

1. Work only on the `web` profile. Back up its manifest, lockfile, workspace,
   profile patch and generated root before making changes. Do not rewrite the
   shared-home patch, desktop files or credentials. Keep the package cache;
   reinstalling the retired release has not been proven to work offline.
2. Replace the retired aggregate dependency and bundle entry with the exact
   `@linxin666/dsh-web-all: 0.4.6` release. Preserve the base/web-app bundles and
   explicitly preserve both `dsh-llm-openai` and `dsh-web-openai-codex` dependency
   links and bundle selections. The UI aggregate does **not** supply OpenAI/Codex.
   Example local dependencies (replace paths with your own checkout):

   ```json
   {
     "@linxin666/dsh-web-all": "0.4.6",
     "dsh-llm-openai": "link:/path/to/gpt-oauth",
     "dsh-web-openai-codex": "link:/path/to/gpt-oauth/packages/dsh-web-openai-codex"
   }
   ```

   The selected bundles should include:

   ```json
   [
     "@deepseek-ai/dsh-base",
     "@deepseek-ai/dsh-web-app",
     "@linxin666/dsh-web-all",
     "dsh-llm-openai",
     "dsh-web-openai-codex"
   ]
   ```

3. Enable SSH using the profile override below. Remove duplicate hand-inserted
   `llm-openai`/`web-openai-codex` rows if their selected bundles already insert
   them. Preserve other unrelated profile overrides.

   ```yaml
   - id: web-ui-ssh
     disabled: false
   ```

4. Copy the [skin isolation patch](<../patches/dsh-client-ui-skin-center-0.4.6-profile-local.patch>)
   and [shell secret-redaction patch](<../patches/dsh-web-all-0.4.6-secret-redaction.patch>)
   into a `patches` directory inside the web profile. Merge these settings into
   that profile's pnpm workspace; do not overwrite unrelated overrides, patches
   or existing build/security settings:

   ```yaml
   nodeLinker: hoisted
   autoInstallPeers: false
   overrides:
     '@linxin666/dsh-pet': 0.4.6
     '@linxin666/dsh-client-ui-community-plugins': 0.4.6
     '@linxin666/dsh-client-ui-preset-center': 0.4.6
     '@linxin666/dsh-client-ui-skin-center': 0.4.6
   patchedDependencies:
     '@linxin666/dsh-client-ui-skin-center@0.4.6': patches/dsh-client-ui-skin-center-0.4.6-profile-local.patch
     '@linxin666/dsh-web-all@0.4.6': patches/dsh-web-all-0.4.6-secret-redaction.patch
   ```

   Four aggregate dependencies use caret ranges; these overrides pin the reviewed
   release so a family update cannot silently bypass a version-specific patch.
   If your pnpm release-age policy blocks this release, approve only reviewed
   exact package/version pairs. `minimumReleaseAgeExclude` is not a version pin;
   wildcard names combined with versions such as `@linxin666/*@0.4.6` are invalid.
   Do not disable the supply-chain policy globally.

5. Reinstall using the profile's package manager with scripts disabled, inspect
   the resulting changes and ensure the lockfile records both patch hashes.
   Then run a frozen install with scripts disabled to confirm reproducibility.
   Do not install a second DSH/React runtime just to silence isolated-profile
   peer warnings: the official resolver and browser shell supply those peers.

## Why the patches are necessary

### Profile-local skins

The published skin center shares custom skin assets/state under DSH home and
runs legacy-selection cleanup that can rewrite shared skin overrides. The
[skin isolation patch](<../patches/dsh-client-ui-skin-center-0.4.6-profile-local.patch>)
derives the profile from the installed package location, places assets and
active state inside that profile, and skips automatic legacy migration/cleanup.
It intentionally does not copy desktop selection or move/delete shared assets.

This isolates skin-center state, **not** all shared Harness data. Sessions,
credentials and MCP may still be intentionally shared. The host settings service
can independently import a legacy home settings document on first activation;
review that migration if such a document exists before launching another profile.
Disabled legacy-skin overrides may warn about missing rows. Do not edit the shared
home layer merely to silence those warnings; review their IDs individually.

### Native settings secret metadata

All aggregate family subpaths share a root `Schema.any().volatile()` Config.
The host SettingsForms reads this shell Config, not the nested family Config.
Consequently the remote family's `tunnelToken` loses its `role("secret")` marker;
if configured, the native settings descriptor and Web bridge can expose it in
`value`, `base` or `user` despite requesting secret redaction.

The [shell secret-redaction patch](<../patches/dsh-web-all-0.4.6-secret-redaction.patch>)
uses an any-first union with a second branch declaring that known secret:

```js
const Config = Schema.union([
  Schema.any(),
  Schema.object({ tunnelToken: Schema.any().role("secret") })
]).volatile();
```

Runtime parsing still takes the `any` branch. The current official redactor
walks every union branch, preserving lazy imports, arbitrary input acceptance,
unknown public fields and the single root `.get()` live reference while omitting
the token from redacted descriptors. Replacing the shell with the full family
schema would change deferred validation and nested volatile-reference behavior.
Bridge-only filtering would leave native settings descriptors vulnerable.

This overlay covers only the audited top-level `tunnelToken` name. It is not
future-secret discovery or full family validation. Root volatility still permits
arbitrary field edits; nested family validation happens when the plugin mounts.
No real token was read, and no evidence of an actual disclosure was established.

## Service-free verification

Run the [verification script](<../scripts/verify-web-profile-ui.mjs>) from this
checkout against the migrated profile:

```powershell
node scripts/verify-web-profile-ui.mjs
# For a nonstandard installation, supply explicit paths:
node scripts/verify-web-profile-ui.mjs --home <DSH_HOME> --profile-dir <WEB_PROFILE> --install-anchor <DSH_PACKAGE_JSON>
# Optional: --output <NEW_ABSOLUTE_JSON_PATH_INSIDE_THIS_CHECKOUT>
```

Replace the angle-bracket placeholders before running commands. The profile
directory must be named `web`. On Windows the default anchor is the global npm
DSH installation; other layouts should pass their real installed DSH manifest.
The output path must be new, inside this checkout and outside DSH home. Reports
contain local paths/configuration metadata and should remain private; matching
root-level `web-profile-ui-verification*.json` outputs are ignored by Git.
Output containment checks are lexical; do not direct reports through symlinks
or junctions to external locations.

The script uses official host resolution, admission and client-module registry
APIs. It imports host modules and shell subpaths, composes YAML in memory, checks
seven enabled feature rows and both provider rows, captures browser registrations
without calling factories, checks dependency coverage and exercises controlled
in-memory route handlers. Configuration values are not printed; credential files are not opened. No
plugin `apply`, listener or network request is made.

The [skin route helper](<../scripts/verify-skin-routes.mjs>) exercises ten actual
handlers: catalog, active state, stylesheet, patches, reviewed hooks, missing
skin, unknown resource, wrong method, cross-site write and built-in uninstall.
It checks CSS safety transformation/hook delivery, not rendering/execution.

The [synthetic secret regression](<../scripts/verify-shell-secrets.mjs>) invokes
the real SettingsForms prototype without its constructor, using only fake
current/base/user values. It checks all three descriptor layers, write-only
sidecar metadata, plain family parsing and seven root-any edge cases. The
installed Web bridge does not export its handlers, so bridge wire invocation is
explicitly untested rather than indirectly starting services.

The completed DSH `0.2.0-rc.2` migration passed:

- 71 main assertions, 22 host imports and 14 shell-subpath imports;
- 20 synthetic secret checks, including seven parsing edge cases;
- 83 browser artifacts and three chunks registered without executing factories;
- ten skin-route requests with no state writes;
- syntax checks and 47 OpenAI + 38 Codex offline regression tests;
- a frozen install plus unchanged protected desktop/shared-home file hashes.

Exact composition/graph counts are installation-specific. The verifier is a
version-specific migration check, not a general test of arbitrary future bundles.
Its disabled-expression and warning allowlists are deliberately narrow.

Use an isolated home for mocked provider regression logs:

```powershell
npm run check
$previousDshHome = $env:DSH_HOME
try {
  $env:DSH_HOME = Join-Path $env:TEMP ('dsh-ui-regression-' + [guid]::NewGuid())
  npm test
} finally {
  $env:DSH_HOME = $previousDshHome
}
```

**Not verified:** live deferred plugin activation/reload, task execution, SSH,
remote pairing/tunnels/revocation, browser service injection or DOM rendering.
An inspected legacy remote `api/gate` listener has no current host emitter;
current direct `/api` has its own auth/origin fence, and stopping remote access
is not a promise to revoke direct `/api` access. No authentication bypass was
established. A real browser acceptance test needs an explicitly started web
profile on a separate port. Refreshing the desktop GUI does not activate it.

## Rollback

Stop only a separately started web process, never the desktop GUI. Restore the
backed-up profile package-manager files and profile patch, then reconstruct the
original frozen installation if registry metadata/cache/security policy permit.
A tested isolated offline reconstruction could not finish because dependency
metadata was missing; complete reinstall rollback is **not verified**. Preserve
backups/cache and resolve that availability before attempting a rollback.
The retired bundle would still be incompatible with DSH `0.2.0-rc.2`; restoring
configuration is not a compatibility fix. Shared-home and desktop files should
not need restoring because this procedure does not modify them.
