$ErrorActionPreference = 'Stop'

$source = Split-Path -Parent $MyInvocation.MyCommand.Path
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileModules = Join-Path $dshHome 'profiles\web\node_modules'
$pluginLink = Join-Path $profileModules 'dsh-llm-openai'
$fallback = Join-Path $dshHome 'profiles\node_modules'
$dependencyLink = Join-Path $source 'node_modules'
$npmBin = Join-Path $env:APPDATA 'npm'
$loginCommand = Join-Path $npmBin 'dsh-openai-login.cmd'
$node = (Get-Command node -ErrorAction Stop).Source

if (-not (Test-Path -LiteralPath $fallback)) {
  throw "dsh fallback modules not found: $fallback (run 'dsh web --help' once first)"
}
if (-not (Test-Path -LiteralPath $profileModules)) {
  New-Item -ItemType Directory -Path $profileModules | Out-Null
}
if (-not (Test-Path -LiteralPath $npmBin)) {
  New-Item -ItemType Directory -Path $npmBin | Out-Null
}

function Ensure-Junction([string]$Path, [string]$Target, [string]$Label) {
  if (Test-Path -LiteralPath $Path) {
    $item = Get-Item -LiteralPath $Path -Force
    $sameTarget = ($item.LinkType -eq 'Junction') -and `
      [string]::Equals(($item.Target -join ''), $Target, [System.StringComparison]::OrdinalIgnoreCase)
    if ($sameTarget) {
      Write-Host "$Label already ok: $Path -> $Target"
      return
    }
    $kind = if ($item.LinkType) { $item.LinkType } else { $item.GetType().Name }
    throw "$Path already exists as $kind and is not the expected junction; refusing to replace it"
  }
  New-Item -ItemType Junction -Path $Path -Target $Target | Out-Null
  Write-Host "$Label created: $Path -> $Target"
}

Ensure-Junction $pluginLink $source 'plugin link'
Ensure-Junction $dependencyLink $fallback 'dependency link'

$loginScript = Join-Path $source 'login.mjs'
$legacyLoginCommandBody = "@echo off`r`n`"$node`" `"$loginScript`" %*`r`n"
$loginCommandBody = "@echo off`r`nrem Created by dsh-llm-openai link-to-dsh.ps1`r`n`"$node`" `"$loginScript`" %*`r`n"
if (Test-Path -LiteralPath $loginCommand) {
  $existingCommand = Get-Content -LiteralPath $loginCommand -Raw
  if ($existingCommand -ceq $loginCommandBody) {
    Write-Host "login command already ok: $loginCommand"
  } elseif ($existingCommand -ceq $legacyLoginCommandBody) {
    Set-Content -LiteralPath $loginCommand -Value $loginCommandBody -Encoding ascii -NoNewline
    Write-Host "legacy login command upgraded: $loginCommand"
  } else {
    throw "$loginCommand already exists and is not this installer's exact shim; refusing to overwrite it"
  }
} else {
  Set-Content -LiteralPath $loginCommand -Value $loginCommandBody -Encoding ascii -NoNewline
  Write-Host "login command installed: $loginCommand"
}
