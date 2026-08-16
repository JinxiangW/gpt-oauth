$ErrorActionPreference = 'Stop'

$source = Split-Path -Parent $MyInvocation.MyCommand.Path
$pluginLink = Join-Path $env:USERPROFILE '.dsh\profiles\web\node_modules\dsh-llm-openai'
$fallback = Join-Path $env:USERPROFILE '.dsh\profiles\node_modules'
$dependencyLink = Join-Path $source 'node_modules'

if (-not (Test-Path $fallback)) {
  throw "dsh fallback modules not found: $fallback (run npx @deepseek-ai/dsh web --help once first)"
}

if (Test-Path $pluginLink) {
  $item = Get-Item $pluginLink -Force
  if ($item.LinkType -eq 'Junction' -and $item.Target -eq $source) {
    Write-Host "plugin link already ok: $pluginLink"
  } else {
    Remove-Item -Recurse -Force $pluginLink
    New-Item -ItemType Junction -Path $pluginLink -Target $source | Out-Null
    Write-Host "plugin link created: $pluginLink -> $source"
  }
} else {
  New-Item -ItemType Junction -Path $pluginLink -Target $source | Out-Null
  Write-Host "plugin link created: $pluginLink -> $source"
}

if (-not (Test-Path $dependencyLink)) {
  New-Item -ItemType Junction -Path $dependencyLink -Target $fallback | Out-Null
  Write-Host "dependency link created: $dependencyLink -> $fallback"
} else {
  Write-Host "dependency link already exists: $dependencyLink"
}
