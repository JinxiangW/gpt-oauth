# Restore the ChatGPT/Codex web-search composition into the DSH desktop profile.
#
# Why this exists: when the Desktop Host fails its startup audit, the Electron
# app's own recovery routine backs up the profile's cordis.patch.yml and clears
# it (along with the bundle list in package.json). The crash is in the host's
# startup path, not in this configuration -- the same configuration cold-boots
# cleanly -- so re-applying it is safe and is all that is needed.
#
# Usage (close DeepSeek Harness first, or expect one more restart):
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\restore-desktop-composition.ps1
param(
  [string]$Profile = "desktop"
)

$ErrorActionPreference = 'Stop'
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileRoot = Join-Path $dshHome "profiles\$Profile"
$manifest = Join-Path $profileRoot 'package.json'
$patch = Join-Path $profileRoot 'cordis.patch.yml'
$modules = Join-Path $profileRoot 'node_modules'
$source = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Test-Path -LiteralPath $manifest)) { throw "profile not found: $profileRoot" }

# 1. Bundles: DSH only mounts a plugin whose package is declared here.
$json = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
if ($null -eq $json.dsh -or $null -eq $json.dsh.profile) { throw "no dsh.profile section in $manifest" }
$bundles = [System.Collections.Generic.List[string]]::new()
foreach ($b in @($json.dsh.profile.bundles)) { if ($b) { $bundles.Add([string]$b) } }
foreach ($b in @('dsh-llm-openai', 'dsh-web-openai-codex')) {
  if (-not $bundles.Contains($b)) { $bundles.Add($b); Write-Host "bundle declared: $b" }
}
$json.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @($bundles) -Force
[System.IO.File]::WriteAllText($manifest, ($json | ConvertTo-Json -Depth 20), [System.Text.UTF8Encoding]::new($false))

# 2. Junctions so the host loads this checkout in place (a pnpm `file:` copy
#    would go stale on every edit).
if (-not (Test-Path -LiteralPath $modules)) { New-Item -ItemType Directory -Path $modules | Out-Null }
function Ensure-Junction([string]$Path, [string]$Target) {
  if (Test-Path -LiteralPath $Path) {
    $item = Get-Item -LiteralPath $Path -Force
    $resolved = @($item.Target)
    if (($item.LinkType -eq 'Junction') -and $resolved.Count -gt 0 -and
        [string]::Equals($resolved[0], $Target, [System.StringComparison]::OrdinalIgnoreCase)) { return }
    throw "$Path exists and is not the expected junction; remove it first"
  }
  New-Item -ItemType Junction -Path $Path -Target $Target | Out-Null
  Write-Host "linked: $Path"
}
Ensure-Junction (Join-Path $modules 'dsh-llm-openai') $source
Ensure-Junction (Join-Path $modules 'dsh-web-openai-codex') (Join-Path $source 'packages\dsh-web-openai-codex')

# 3. Patch layer: select the search provider and keep the app's own MCP rows.
$appPatch = @'
# --- DSH profile patch: project preferences ---------------------------------
- id: web
  config:
    searchProvider: openai-codex

- id: web-openai-codex
  name: dsh-web-openai-codex
  config:
    searchModel: gpt-6-luna
'@

# Preserve the user's own rows (MCP servers, model default, permissions) if a
# previous patch is still around, so restoring never drops their settings.
$candidates = @(
  (Join-Path $profileRoot 'cordis.patch.yml.bak-1790844722990'),
  (Join-Path $profileRoot 'cordis.patch.yml.state-at-1700')
) | Where-Object { Test-Path -LiteralPath $_ }
$userRows = ''
foreach ($candidate in $candidates) {
  $text = Get-Content -LiteralPath $candidate -Raw
  if ($text -match 'mcp-unity|agent-default-model') { $userRows = $text; break }
}
if ($userRows.Length -gt 0) {
  # Drop our own rows from the recovered text; they are re-added explicitly below.
  $lines = $userRows -split "`r?`n"
  $kept = [System.Collections.Generic.List[string]]::new()
  $skip = $false
  foreach ($line in $lines) {
    if ($line -match '^\s*#') { continue }
    if ($line -match '^\s*-\s*id:\s*(web|web-openai-codex)\s*$') { $skip = $true; continue }
    if ($line -match '^-\s*insert:') { $skip = $false }
    if ($line -match '^\s*-\s*id:') { $skip = $false }
    if ($line -match 'searchProvider:|searchModel:') { continue }
    if (-not $skip) { $kept.Add($line) }
  }
  $userRows = ($kept -join "`n").Trim()
  if ($userRows.Length -gt 0) { $userRows = "# --- recovered profile rows ---`n$userRows" }
}

$body = if ($userRows.Length -gt 0) { "$appPatch`n$userRows`n" } else { "$appPatch" }
[System.IO.File]::WriteAllText($patch, $body, [System.Text.UTF8Encoding]::new($false))
Write-Host "patch written: $patch"
Write-Host ''
Write-Host 'Now start DeepSeek Harness. Expected: an "OpenAI (ChatGPT)" group with gpt-6-* models.'
