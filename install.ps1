# install.ps1 - install dsh-editing-message into the web profile (dsh v0.2.0-rc.2).
#
# Run from anywhere:  powershell -ExecutionPolicy Bypass -File install.ps1
#
# The ONLY supported install is the harness's own: this script packs this
# folder into a tarball (pnpm pack) and runs
#   pnpm dsh plugin --profile web add <that tarball>
# from the harness checkout. That registers the package as a profile bundle:
# the harness adds it to the profile manifest, installs a REAL COPY of the
# package into the profile's node_modules, and loads cordis.patch.yml from the
# bundle as an overlay row. The Plugins page then lists the plugin with the
# enable switch.
# Because the profile holds its own copy, this folder can be moved or deleted
# at any time without breaking the running plugin.
#
# This script performs, in order:
#   1. remove the legacy link: dependency (this installer's older runs), if any;
#   2. remove the legacy installed copy under %DSH_HOME%\plugins (old flow);
#   3. pack the folder, run the official `dsh plugin add <tarball>`, then
#      clean up POINTWISE: only the exact stale same-version artifact path and
#      the exact previously-referenced artifact path of THIS package. No mask
#      deletions anywhere.
#
# Idempotent: re-running refreshes everything. After editing the plugin
# source, re-run this script so the profile copies the new bytes.
# ASCII-only source: Windows PowerShell 5.1 reads BOM-less files as ANSI.

param(
  # Harness source checkout (provides the dsh CLI).
  # Probed automatically when omitted.
  [string]$HarnessRoot = '',
  # Profile to install into. The web app is this plugin's target.
  [string]$Profile = 'web'
)

$ErrorActionPreference = 'Stop'

# --- Locate the delivery folder ------------------------------------------------
$PluginDir = $PSScriptRoot
if ([string]::IsNullOrEmpty($PluginDir)) {
  throw 'install.ps1 must run as a saved script file (needs $PSScriptRoot).'
}

# --- Resolve the harness home ---------------------------------------------------
$DshHome = $env:DSH_HOME
if ([string]::IsNullOrEmpty($DshHome)) { $DshHome = Join-Path $env:USERPROFILE '.dsh' }

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
if ($null -eq $Harness) {
  throw ("Harness checkout not found. Pass it explicitly: install.ps1 -HarnessRoot <path> " +
         "(looked in: $($HarnessCandidates -join '; ')).")
}
Write-Host "Harness checkout : $Harness"

# --- Read the exact package identity ---------------------------------------------
$Manifest = Get-Content (Join-Path $PluginDir 'package.json') -Raw | ConvertFrom-Json
$PackageName = $Manifest.name
$ArtifactName = '{0}-{1}.tgz' -f $Manifest.name, $Manifest.version
$ArtifactsDir = Join-Path $DshHome "profiles/$Profile/.artifacts"
New-Item -ItemType Directory -Force -Path $ArtifactsDir | Out-Null
$ArtifactPath = Join-Path $ArtifactsDir $ArtifactName

# --- 1. Remove a legacy link: dependency (older run of this installer) -----------
# The plugin-manager may install with a link: spec, which dies when this
# folder moves. The tarball install replaces it.
$ProfileManifestPath = Join-Path $DshHome "profiles/$Profile/package.json"
$OldArtifact = $null
if (Test-Path -LiteralPath $ProfileManifestPath) {
  $ProfileManifest = Get-Content $ProfileManifestPath -Raw | ConvertFrom-Json
  $OldDep = $ProfileManifest.dependencies.($PackageName)
  if ($null -ne $OldDep -and $OldDep -match '^(link|file):(.+)$') {
    $Resolved = [System.IO.Path]::GetFullPath($Matches[2])
    if ($Matches[1] -eq 'link') {
      Write-Host "Removing the legacy link: dependency ($OldDep) via the official CLI first."
      Push-Location $Harness
      try {
        & pnpm dsh plugin --profile $Profile remove $PackageName
        if ($LASTEXITCODE -ne 0) {
          Write-Host "dsh plugin remove reported exit code $LASTEXITCODE (continuing)." -ForegroundColor Yellow
        }
      } finally {
        Pop-Location
      }
      $ProfileManifest = Get-Content $ProfileManifestPath -Raw | ConvertFrom-Json
      $OldDep = $ProfileManifest.dependencies.($PackageName)
    }
    if ($null -ne $OldDep -and $OldDep -match '^file:(.+\.tgz)$') {
      $OldArtifact = [System.IO.Path]::GetFullPath($Matches[1])
    }
  }
}

# --- 2. Remove the legacy installed copy (old flow artifact) ----------------------
$LegacyCopy = Join-Path $DshHome "plugins/$PackageName"
if (Test-Path -LiteralPath $LegacyCopy) {
  Remove-Item -Recurse -Force -LiteralPath $LegacyCopy
  Write-Host "Removed the legacy installed copy: $LegacyCopy"
}

# A referenced-but-missing tarball would break the add's dependency
# resolution: clear the stale bundle first (official CLI, no manual edits).
if ($null -ne $OldArtifact -and -not (Test-Path -LiteralPath $OldArtifact)) {
  Write-Host "The profile references a missing tarball ($([System.IO.Path]::GetFileName($OldArtifact))); clearing the stale bundle first."
  Push-Location $Harness
  try {
    & pnpm dsh plugin --profile $Profile remove $PackageName
    if ($LASTEXITCODE -ne 0) {
      Write-Host "dsh plugin remove reported exit code $LASTEXITCODE (continuing)." -ForegroundColor Yellow
    }
  } finally {
    Pop-Location
  }
  $OldArtifact = $null
}

# --- 3. Pointwise pre-clean: the exact same-version artifact path -----------------
if (Test-Path -LiteralPath $ArtifactPath) {
  Remove-Item -Force -LiteralPath $ArtifactPath
  Write-Host "Removed the stale same-version artifact: $ArtifactPath"
}

# Pack from a staging copy WITHOUT tarballs: a previous run's .tgz sitting in
# the folder would be packed INSIDE the new artifact. The staging copy is
# exact (all files but *.tgz + every subdirectory) and removed afterwards.
$Stage = Join-Path $env:TEMP ('dsh-em-pack-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $Stage | Out-Null
try {
  Get-ChildItem -LiteralPath $PluginDir -File | Where-Object { $_.Extension -ne '.tgz' } | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $Stage
  }
  Get-ChildItem -LiteralPath $PluginDir -Directory | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $Stage -Recurse
  }
  Push-Location $Stage
  try {
    & pnpm pack --pack-destination $ArtifactsDir
    if ($LASTEXITCODE -ne 0) { throw "pnpm pack failed (exit code $LASTEXITCODE)." }
  } finally {
    Pop-Location
  }
} finally {
  Remove-Item -Recurse -Force -LiteralPath $Stage -ErrorAction SilentlyContinue
}
if (-not (Test-Path -LiteralPath $ArtifactPath)) { throw "pnpm pack produced no $ArtifactName." }
$Bundle = Get-Item -LiteralPath $ArtifactPath
Write-Host "Packed the bundle: $($Bundle.FullName)"

Write-Host "Installing the bundle: pnpm dsh plugin --profile $Profile add `"$($Bundle.FullName)`""
Push-Location $Harness
try {
  & pnpm dsh plugin --profile $Profile add $Bundle.FullName
  if ($LASTEXITCODE -ne 0) {
    throw "dsh plugin add failed (exit code $LASTEXITCODE)."
  }
} finally {
  Pop-Location
}

# The add has succeeded; the manifest now points at the current artifact, so
# it STAYS. Everything superseded goes POINTWISE - exact paths only, this
# package's artifacts only:
#   - the previously referenced artifact (old version / old location);
#   - tarballs left in the master folder under the exact current name.
if ($null -ne $OldArtifact -and $OldArtifact -ne [System.IO.Path]::GetFullPath($ArtifactPath) -and (Test-Path -LiteralPath $OldArtifact)) {
  Remove-Item -Force -LiteralPath $OldArtifact
  Write-Host "Removed the superseded artifact: $OldArtifact"
}
$Leftover = Join-Path $PluginDir $ArtifactName
if (Test-Path -LiteralPath $Leftover) {
  Remove-Item -Force -LiteralPath $Leftover
  Write-Host "Removed the old-scheme artifact from the master folder: $Leftover"
}
Write-Host "Kept the referenced artifact: $ArtifactPath"

# --- Post-install verification: the profile copy must carry the packed bytes -----
# pnpm reuses an unchanged name@version copy from its store ("Already up to
# date"), which can leave a STALE copy when the code changed without a version
# bump. Hash-compare the live copy against this folder and say so loudly.
$ProfileCopy = Join-Path $DshHome "profiles/$Profile/node_modules/$PackageName/client.js"
$SourceClient = Join-Path $PluginDir 'client.js'
if ((Test-Path -LiteralPath $ProfileCopy) -and (Test-Path -LiteralPath $SourceClient)) {
  $copyHash = (Get-FileHash -LiteralPath $ProfileCopy -Algorithm SHA256).Hash
  $sourceHash = (Get-FileHash -LiteralPath $SourceClient -Algorithm SHA256).Hash
  if ($copyHash -ne $sourceHash) {
    Write-Host ''
    Write-Host 'WARNING: the profile copy of client.js does NOT match this folder.' -ForegroundColor Red
    Write-Host 'pnpm reused its store copy for the same name@version. Bump "version" in' -ForegroundColor Red
    Write-Host 'package.json and re-run this script, or remove the bundle first:' -ForegroundColor Red
    Write-Host "  pnpm dsh plugin --profile $Profile remove $PackageName" -ForegroundColor Red
  } else {
    Write-Host 'Verified: the profile copy matches this folder byte-for-byte.' -ForegroundColor Green
  }
}

Write-Host ''
Write-Host "$PackageName installed as a profile bundle." -ForegroundColor Green
Write-Host "  master folder : $PluginDir (portable - move or delete it freely, the profile holds its own copy)"
Write-Host "  profile copy  : $DshHome\profiles\$Profile\node_modules\$PackageName (refreshed by install.ps1)"
Write-Host "  artifact      : $ArtifactPath (referenced by the profile manifest; kept)"
Write-Host ''
Write-Host 'Restart "pnpm dsh web" if the harness was running, then refresh the page (F5).'
Write-Host 'The Plugins page then lists the plugin with the enable switch.'
Write-Host 'To uninstall later, run uninstall.ps1.'
