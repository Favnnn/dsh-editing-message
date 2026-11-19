# uninstall.ps1 - remove dsh-editing-message from the web profile.
# ASCII-only source: Windows PowerShell 5.1 reads BOM-less files as ANSI.
#
# The plugin installs as a profile bundle, so the primary step is the
# harness's own removal (`pnpm dsh plugin --profile web remove ...`) run from
# the harness checkout. The script also cleans up what older installers left:
# the legacy installed copy under %DSH_HOME%\plugins and the exact artifact
# the profile manifest referenced. Deletions are POINTWISE (exact paths),
# never masks. The master folder (this folder) is left in place.

param(
  # Harness source checkout. Probed automatically when omitted.
  [string]$HarnessRoot = '',
  # Profile the bundle was installed into.
  [string]$Profile = 'web'
)

$ErrorActionPreference = 'Stop'

$ScriptDir = $PSScriptRoot

$DshHome = $env:DSH_HOME
if ([string]::IsNullOrEmpty($DshHome)) { $DshHome = Join-Path $env:USERPROFILE '.dsh' }

$Manifest = Get-Content (Join-Path $ScriptDir 'package.json') -Raw | ConvertFrom-Json
$PackageName = $Manifest.name

# --- Locate the harness checkout -------------------------------------------------
$HarnessCandidates = @(
  $HarnessRoot,
  $env:DSH_ROOT,
  'C:\Deepseek-Harness\deepseek-harness-v0.2.0-rc.2',
  'C:\Deepseek-Harness\deepseek-harness'
) | Where-Object { -not [string]::IsNullOrEmpty($_) }

$Harness = $null
foreach ($Root in $HarnessCandidates) {
  if (Test-Path (Join-Path $Root 'apps/cli/package.json')) { $Harness = $Root; break }
}

# --- 1. Remember the artifact the profile references, for exact cleanup ----------
$ReferencedArtifact = $null
$ProfileManifestPath = Join-Path $DshHome "profiles/$Profile/package.json"
if (Test-Path -LiteralPath $ProfileManifestPath) {
  try {
    $Dep = (Get-Content $ProfileManifestPath -Raw | ConvertFrom-Json).dependencies.($PackageName)
  } catch {
    $Dep = $null
  }
  if ($null -ne $Dep -and $Dep -match '^file:(.+\.tgz)$') {
    $ReferencedArtifact = [System.IO.Path]::GetFullPath($Matches[1])
  }
}

# --- 2. The official removal -----------------------------------------------------
if ($null -ne $Harness) {
  Write-Host "Removing the bundle: pnpm dsh plugin --profile $Profile remove $PackageName"
  Push-Location $Harness
  try {
    & pnpm dsh plugin --profile $Profile remove $PackageName
    if ($LASTEXITCODE -ne 0) {
      Write-Host "dsh plugin remove reported exit code $LASTEXITCODE (not installed?)." -ForegroundColor Yellow
    }
  } finally {
    Pop-Location
  }
} else {
  Write-Host 'Harness checkout not found; pass -HarnessRoot to remove the bundle via the CLI.' -ForegroundColor Yellow
  Write-Host 'Continuing with legacy cleanup only.' -ForegroundColor Yellow
}

# --- 3. Remove the legacy installed copy (old flow artifact) ----------------------
$LegacyCopy = Join-Path $DshHome "plugins/$PackageName"
if (Test-Path -LiteralPath $LegacyCopy) {
  try {
    Remove-Item -Recurse -Force -LiteralPath $LegacyCopy -ErrorAction Stop
    Write-Host "Removed the legacy installed copy $LegacyCopy" -ForegroundColor Green
  } catch {
    Write-Host "Could not delete $LegacyCopy (script may be running from it); delete it manually." -ForegroundColor Yellow
  }
}

# --- 4. Remove the exact artifact the profile referenced (pointwise) --------------
if ($null -ne $ReferencedArtifact -and (Test-Path -LiteralPath $ReferencedArtifact)) {
  try {
    Remove-Item -Force -LiteralPath $ReferencedArtifact -ErrorAction Stop
    Write-Host "Removed the referenced artifact: $ReferencedArtifact" -ForegroundColor Green
  } catch {
    Write-Host "Could not delete $ReferencedArtifact; delete it manually." -ForegroundColor Yellow
  }
}

Write-Host ''
Write-Host "$PackageName uninstalled. Restart the web server to apply."
Write-Host "The delivery folder $ScriptDir was left in place; delete it if you no longer need it."
