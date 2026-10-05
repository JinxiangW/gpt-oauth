param(
  [string]$Profile = $(if ($env:DSH_PROFILE) { $env:DSH_PROFILE } else { 'desktop' }),
  [switch]$AllowRunningApp
)

$ErrorActionPreference = 'Stop'

# Link this checkout into a DSH profile as junctions and declare both bundles.
# Junctions (not `pnpm add file:...`) are deliberate: a `file:` dependency is
# materialized as a snapshot copy, so source edits would not reach a running
# host until the profile is reinstalled.
#
# Launching DeepSeek Harness boots the `desktop` profile, so that is the default
# target. `dsh plugin --profile desktop ...` is rejected by the application, so
# this script writes the manifest and the junctions itself.

$source = Split-Path -Parent $MyInvocation.MyCommand.Path
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileRoot = Join-Path $dshHome "profiles\$Profile"
$profileManifest = Join-Path $profileRoot 'package.json'
$profileModules = Join-Path $profileRoot 'node_modules'
$webPluginSource = Join-Path $source 'packages\dsh-web-openai-codex'
$bundles = @('dsh-llm-openai', 'dsh-web-openai-codex')

if (-not (Test-Path -LiteralPath $webPluginSource)) {
  throw "Codex web plugin source not found: $webPluginSource"
}
if (-not (Test-Path -LiteralPath $profileManifest)) {
  throw "DSH profile manifest not found: $profileManifest (is profile '$Profile' initialized?)"
}

# The host reads the manifest and every junction at boot; a live process would
# keep serving the old tree while it is rewritten under it.
$running = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
if ($running -and -not $AllowRunningApp) {
  throw "DeepSeek Harness is running (pid $($running.Id -join ', ')); close it first, or pass -AllowRunningApp to relink without restarting it"
}

if (-not (Test-Path -LiteralPath $profileModules)) {
  New-Item -ItemType Directory -Path $profileModules | Out-Null
}

function Ensure-Junction([string]$Path, [string]$Target, [string]$Label) {
  if (Test-Path -LiteralPath $Path) {
    $item = Get-Item -LiteralPath $Path -Force
    $resolved = @($item.Target)
    $sameTarget = ($item.LinkType -eq 'Junction') -and
      $resolved.Count -gt 0 -and
      [string]::Equals($resolved[0], $Target, [System.StringComparison]::OrdinalIgnoreCase)
    if ($sameTarget) {
      Write-Host "$Label already ok: $Path -> $Target"
      return
    }
    $kind = if ($item.LinkType) { $item.LinkType } else { $item.GetType().Name }
    throw "$Path already exists as $kind and is not the expected junction; refusing to replace it (remove it yourself to relink)"
  }
  New-Item -ItemType Junction -Path $Path -Target $Target | Out-Null
  Write-Host "$Label created: $Path -> $Target"
}

Ensure-Junction (Join-Path $profileModules 'dsh-llm-openai') $source 'LLM plugin link'
Ensure-Junction (Join-Path $profileModules 'dsh-web-openai-codex') $webPluginSource 'Codex web plugin link'

# Node resolves imports from a junction's real checkout path. The sibling link
# in the profile is therefore insufficient for the Web package's LLM peer.
$webPluginModules = Join-Path $webPluginSource 'node_modules'
if (-not (Test-Path -LiteralPath $webPluginModules)) {
  New-Item -ItemType Directory -Path $webPluginModules | Out-Null
}
Ensure-Junction (Join-Path $webPluginModules 'dsh-llm-openai') $source 'Web plugin LLM peer link'

$manifest = Get-Content -LiteralPath $profileManifest -Raw | ConvertFrom-Json
if ($null -eq $manifest.dsh -or $null -eq $manifest.dsh.profile) {
  throw "DSH profile manifest has no dsh.profile section: $profileManifest"
}
$declared = [System.Collections.Generic.List[string]]::new()
foreach ($bundle in @($manifest.dsh.profile.bundles)) { if ($bundle) { $declared.Add([string]$bundle) } }
foreach ($bundle in $bundles) {
  if (-not $declared.Contains($bundle)) {
    $declared.Add($bundle)
    Write-Host "profile bundle enabled: $bundle"
  }
}
$manifest.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @($declared) -Force
[System.IO.File]::WriteAllText($profileManifest, ($manifest | ConvertTo-Json -Depth 20), [System.Text.UTF8Encoding]::new($false))

# The ChatGPT OAuth login entry point is a standalone CLI, not a Loader row.
$node = (Get-Command node -ErrorAction Stop).Source
$npmBin = Join-Path $env:APPDATA 'npm'
$loginCommand = Join-Path $npmBin 'dsh-openai-login.cmd'
$loginScript = Join-Path $source 'login.mjs'
if (-not (Test-Path -LiteralPath $npmBin)) {
  New-Item -ItemType Directory -Path $npmBin | Out-Null
}
$loginCommandBody = "@echo off`r`nrem Created by dsh-llm-openai link-to-dsh.ps1`r`n`"$node`" `"$loginScript`" %*`r`n"
# Desktop peers live inside app.asar, and system Node cannot resolve them.
# The Electron bootstrap shares those peers and uses the Host's Node version.
$desktopExecutable = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'
if ($Profile -eq 'desktop' -and (Test-Path -LiteralPath $desktopExecutable)) {
  $desktopLoginScript = Join-Path $source 'desktop-login.mjs'
  $loginCommandBody = "@echo off`r`nrem Created by dsh-llm-openai link-to-dsh.ps1`r`nsetlocal`r`nset `"ELECTRON_RUN_AS_NODE=1`"`r`n`"$desktopExecutable`" `"$desktopLoginScript`" %*`r`n"
}
if (Test-Path -LiteralPath $loginCommand) {
  $existing = (Get-Content -LiteralPath $loginCommand -Raw) -replace "`r`n", "`n"
  if (-not $existing.Contains($loginScript) -and -not $existing.Contains((Join-Path $source 'desktop-login.mjs'))) {
    throw "$loginCommand already exists and is not this installer's shim; refusing to overwrite it"
  }
  Set-Content -LiteralPath $loginCommand -Value $loginCommandBody -Encoding ascii -NoNewline
  Write-Host "login command refreshed: $loginCommand"
} else {
  Set-Content -LiteralPath $loginCommand -Value $loginCommandBody -Encoding ascii -NoNewline
  Write-Host "login command installed: $loginCommand"
}

Write-Host ''
Write-Host "Linked into profile '$Profile'. Confirm the patch layer selects the provider:"
Write-Host "  $profileRoot\cordis.patch.yml"
Write-Host '    - id: web'
Write-Host '      config:'
Write-Host '        searchProvider: openai-codex'
Write-Host 'Then start DeepSeek Harness; use dsh-openai-login first if ChatGPT OAuth is not stored yet.'
