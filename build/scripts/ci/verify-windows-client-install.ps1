# SPDX-License-Identifier: AGPL-3.0-or-later
param(
  [Parameter(Mandatory = $true)][string]$ArtifactRoot,
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][ValidateSet('stable', 'beta', 'internal')][string]$Channel,
  [Parameter(Mandatory = $true)][string]$OwnedRoot,
  [Parameter(Mandatory = $true)][string]$EvidenceRoot,
  [switch]$PreflightOnly,
  [switch]$RemoveOwnedProtocol
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:OS -ne 'Windows_NT') { throw 'Windows runner required' }
if ($Version -notmatch '^\d+\.\d+\.\d+(?:-[\w.-]+)?$') { throw 'Invalid client version' }
$ArtifactRoot = (Resolve-Path -LiteralPath $ArtifactRoot).Path
$OwnedRoot = [IO.Path]::GetFullPath($OwnedRoot)
$EvidenceRoot = [IO.Path]::GetFullPath($EvidenceRoot)
$temp = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
$temp = [IO.Path]::GetFullPath($temp).TrimEnd('\') + '\'
if (-not $OwnedRoot.StartsWith($temp, [StringComparison]::OrdinalIgnoreCase)) { throw 'Probe root must be below runner temp' }
if (-not $RemoveOwnedProtocol -and (Test-Path -LiteralPath $OwnedRoot)) { throw 'Probe root exists; refusing to discard prior data' }
if ($EvidenceRoot -eq $OwnedRoot -or $EvidenceRoot.StartsWith($OwnedRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Evidence must survive installation cleanup' }
New-Item -ItemType Directory -Force -Path $EvidenceRoot | Out-Null
$product = if ($Channel -eq 'stable') { 'Myoxus' } else { "Myoxus-$Channel" }
function Get-ProtocolTarget([string]$Command) {
  $match = [regex]::Match($Command, '^\s*(?:"(?<exe>[^"\r\n]+\.exe)"|(?<exe>[^\s"]+\.exe))(?:\s|$)', [Text.RegularExpressions.RegexOptions]::IgnoreCase)
  if ($match.Success) { return $match.Groups['exe'].Value }
  return $null
}
if ($RemoveOwnedProtocol) {
  # Only the current task's portable executable may own this cleanup. Never
  # restore guessed registrations or touch an installed application's key.
  if ($Version -notlike '9000.*' -or (Split-Path $OwnedRoot -Leaf) -ne 'portable' -or (Split-Path (Split-Path $OwnedRoot -Parent) -Leaf) -notmatch '^myoxus-electron-update-e2e-[A-Za-z0-9]+$') { throw 'Protocol cleanup requires an owned portable update fixture' }
  $scheme = "HKCU:\Software\Classes\$($product.ToLowerInvariant())"
  if (Test-Path -LiteralPath $scheme) {
    $commandKey = Join-Path $scheme 'shell\open\command'
    if (-not (Test-Path -LiteralPath $commandKey)) { throw 'Owned protocol command is missing' }
    $target = Get-ProtocolTarget ((Get-Item -LiteralPath $commandKey).GetValue(''))
    if (-not $target -or [IO.Path]::GetFullPath($target) -ne (Join-Path $OwnedRoot "$product.exe")) { throw 'Protocol cleanup refuses a foreign executable' }
    Remove-Item -LiteralPath $scheme -Recurse -Force
    if (Test-Path -LiteralPath $scheme) { throw 'Owned protocol registration remains after cleanup' }
  }
  Write-Output 'Owned portable protocol registration is absent; profiles are untouched.'
  return
}
$appId = if ($Channel -eq 'stable') { 'org.myoxus.desktop' } else { "org.myoxus.$Channel" }
# Resolve the deployed GUID through the installer's dependency, not a second UUID algorithm.
$guid = @'
const {UUID}=require(require.resolve("builder-util-runtime",{paths:["client/apps/electron"]}));
process.stdout.write(UUID.v5(process.argv[2],UUID.parse("50e065bc-3134-11e6-9bab-38c9862bdaf3")));
'@ | & node - $appId
if ($LASTEXITCODE -ne 0 -or $guid -notmatch '^[a-fA-F0-9-]{36}$') { throw 'Cannot resolve installer identity' }
$registry = @()
foreach ($hive in @('HKCU:', 'HKLM:')) {
  foreach ($prefix in @('Software', 'Software\WOW6432Node')) {
    $registry += "$hive\$prefix\$guid"
    $registry += "$hive\$prefix\Microsoft\Windows\CurrentVersion\Uninstall\$guid"
    $registry += "$hive\$prefix\Classes\$($product.ToLowerInvariant())"
  }
}
# A portable app can leave only a protocol key after the test removes its files.
# Recover it only with no other installation scope and a missing, non-live task
# directory under the same confirmed CI work root. A user installation never fits.
$schemeOnly = "HKCU:\Software\Classes\$($product.ToLowerInvariant())"
if ((Test-Path -LiteralPath $schemeOnly) -and -not @($registry | Where-Object { $_ -ne $schemeOnly -and (Test-Path -LiteralPath $_) }).Count) {
  $commandKey = Join-Path $schemeOnly 'shell\open\command'
  if (Test-Path -LiteralPath $commandKey) {
    $target = Get-ProtocolTarget ((Get-Item -LiteralPath $commandKey).GetValue(''))
    $runnerWork = [IO.Path]::GetFullPath((Join-Path $temp '..\..')).TrimEnd('\')
    $ownedPortable = '^' + [regex]::Escape($runnerWork) + '\\[a-f0-9]{16}\\tmp\\myoxus-electron-update-e2e-[A-Za-z0-9]+\\portable\\' + [regex]::Escape("$product.exe") + '$'
    if ($target -and $target -match $ownedPortable -and -not (Test-Path -LiteralPath (Split-Path $target -Parent))) {
      foreach ($folder in @('Desktop', 'Programs', 'CommonDesktopDirectory', 'CommonPrograms')) {
        $directory = [Environment]::GetFolderPath($folder)
        if ($directory -and (Test-Path -LiteralPath (Join-Path $directory "$product.lnk"))) { throw 'Portable orphan recovery refuses an existing shortcut' }
      }
      @{ key = $schemeOnly; missingTarget = $target } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $EvidenceRoot 'recovered-portable-protocol.json')
      Remove-Item -LiteralPath $schemeOnly -Recurse -Force
      Write-Output 'Removed only the protocol registration of a missing owned portable fixture.'
    }
  }
}
# Recover only a provable orphan of this probe's predecessor. Its files have
# already been removed by runner cleanup, so there is no uninstaller to invoke.
# A live directory, foreign scope/path, scheme or shortcut always fails closed.
$installKey = "HKCU:\Software\$guid"
if (Test-Path -LiteralPath $installKey) {
  $prior = Get-ItemProperty -LiteralPath $installKey
  $priorPath = if ($prior.PSObject.Properties.Name -contains 'InstallLocation') { $prior.InstallLocation } else { $null }
  $runnerWork = [IO.Path]::GetFullPath((Join-Path $temp '..\..')).TrimEnd('\')
  $ownedPattern = '^' + [regex]::Escape($runnerWork) + '\\[a-f0-9]{16}\\tmp\\myoxus-client-install-\d+\\nsis$'
  if ($priorPath -and $priorPath -match $ownedPattern -and -not (Test-Path -LiteralPath $priorPath)) {
    $uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$guid"
    $schemeKey = "HKCU:\Software\Classes\$($product.ToLowerInvariant())"
    $recoverKeys = @($installKey)
    $orphanTargets = @($priorPath)
    function Assert-OrphanCommand([string]$Command, [bool]$Uninstaller) {
      $match = [regex]::Match($Command, '^\s*(?:"(?<exe>[^"\r\n]+\.exe)"|(?<exe>[^\s"]+\.exe))(?:\s|$)', [Text.RegularExpressions.RegexOptions]::IgnoreCase)
      if (-not $match.Success) { throw 'Orphan recovery refuses an unrecognized command' }
      $executable = $match.Groups['exe'].Value
      $directory = Split-Path $executable -Parent
      $filename = Split-Path $executable -Leaf
      $expected = if ($Uninstaller) { @('Uninstall.exe', "Uninstall $product.exe") } else { @("$product.exe") }
      # Both deployed installer generations use the same channel GUID. Their
      # uninstaller names differ; independently prove every target is a missing
      # predecessor-probe directory rather than assuming the name/path matches.
      if ($directory -notmatch $ownedPattern -or (Test-Path -LiteralPath $directory) -or $filename -notin $expected) {
        throw "Orphan recovery refuses a foreign/live executable: $executable"
      }
      return $directory
    }
    if (Test-Path -LiteralPath $uninstallKey) {
      $command = (Get-ItemProperty -LiteralPath $uninstallKey).UninstallString
      $orphanTargets += Assert-OrphanCommand $command $true
      $recoverKeys += $uninstallKey
    }
    if (Test-Path -LiteralPath $schemeKey) {
      $commandKey = Get-Item -LiteralPath "$schemeKey\shell\open\command"
      $orphanTargets += Assert-OrphanCommand ($commandKey.GetValue('')) $false
      $recoverKeys += $schemeKey
    }
    foreach ($key in $registry) {
      if ((Test-Path -LiteralPath $key) -and $key -notin $recoverKeys) { throw "Orphan recovery refuses another installation scope: $key" }
    }
    $recoverLinks = @()
    $shortcutOwner = New-Object -ComObject WScript.Shell
    foreach ($folder in @('Desktop', 'Programs', 'CommonDesktopDirectory', 'CommonPrograms')) {
      $directory = [Environment]::GetFolderPath($folder)
      if (-not $directory) { continue }
      $link = Join-Path $directory "$product.lnk"
      if (Test-Path -LiteralPath $link) {
        $orphanTargets += Assert-OrphanCommand ('"' + $shortcutOwner.CreateShortcut($link).TargetPath + '"') $false
        $recoverLinks += $link
      }
    }
    @{ installLocation = $priorPath; orphanTargets = $orphanTargets; keys = $recoverKeys; shortcuts = $recoverLinks } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $EvidenceRoot 'recovered-orphan.json')
    foreach ($link in $recoverLinks) { Remove-Item -LiteralPath $link -Force }
    foreach ($key in $recoverKeys) { Remove-Item -LiteralPath $key -Recurse -Force }
    Write-Output "Removed orphaned predecessor-probe registration for missing path $priorPath"
  }
}
# NSIS removes previous registrations before extraction; protect foreign installs before launch.
foreach ($key in $registry) {
  if (Test-Path -LiteralPath $key) {
    $existing = Get-ItemProperty -LiteralPath $key
    $location = if ($existing.PSObject.Properties.Name -contains 'InstallLocation') { $existing.InstallLocation } else { $null }
    $versionInfo = if ($location -and (Test-Path -LiteralPath (Join-Path $location "$product.exe"))) { (Get-Item -LiteralPath (Join-Path $location "$product.exe")).VersionInfo.ProductVersion } else { $null }
    $conflict = @{ key = $key; installLocation = $location; executableVersion = $versionInfo; locationExists = [bool]($location -and (Test-Path -LiteralPath $location)); uninstallerExists = [bool]($location -and (Test-Path -LiteralPath (Join-Path $location 'Uninstall.exe'))) }
    if ($key -like '*\Classes\*') {
      $commandKey = Join-Path $key 'shell\open\command'
      if (Test-Path -LiteralPath $commandKey) {
        $command = (Get-Item -LiteralPath $commandKey).GetValue('')
        $target = Get-ProtocolTarget $command
        $conflict.protocolTarget = $target
        $conflict.protocolTargetExists = [bool]($target -and (Test-Path -LiteralPath $target -PathType Leaf))
      }
    }
    $conflict | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $EvidenceRoot 'registration-conflict.json')
    $conflict | ConvertTo-Json | Write-Output
    throw "Foreign installation/registration exists: $key"
  }
}
foreach ($folder in @('Desktop', 'Programs', 'CommonDesktopDirectory', 'CommonPrograms')) {
  $directory = [Environment]::GetFolderPath($folder)
  if ($directory -and (Test-Path -LiteralPath (Join-Path $directory "$product.lnk"))) { throw "Foreign shortcut exists in $folder" }
}
# The update harness reuses the same ownership gate before its own N install;
# preflight must return before package inventory or any installer side effect.
if ($PreflightOnly) { return }
$installer = @(Get-ChildItem -LiteralPath $ArtifactRoot -Recurse -File -Filter "myoxus-$Version-$Channel-windows-x64.exe")
$archive = @(Get-ChildItem -LiteralPath $ArtifactRoot -Recurse -File -Filter "myoxus-$Version-$Channel-windows-x64.zip")
if ($installer.Count -ne 1 -or $archive.Count -ne 1) { throw 'Expected exactly one canonical NSIS/ZIP pair' }
$nsisRoot = Join-Path $OwnedRoot 'nsis'
$zipRoot = Join-Path $OwnedRoot 'zip'
$results = [Collections.Generic.List[object]]::new()
function Invoke-OwnedProcess([string]$Name, [string]$Executable, [string[]]$Arguments, [int]$TimeoutMs) {
  $out = Join-Path $EvidenceRoot "$Name.stdout.log"
  $err = Join-Path $EvidenceRoot "$Name.stderr.log"
  $process = Start-Process -FilePath $Executable -ArgumentList $Arguments -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
  # Cache the handle before waiting so a missing ExitCode cannot become integer zero.
  $handle = $process.Handle
  $timedOut = -not $process.WaitForExit($TimeoutMs)
  if ($timedOut) {
    & taskkill.exe /PID $process.Id /T /F | Out-Null
    if (-not $process.WaitForExit(10000)) { throw "$Name process tree did not terminate" }
  }
  $process.Refresh()
  $code = $process.ExitCode
  $results.Add(@{ operation = $Name; pid = $process.Id; exitCode = $code; timedOut = $timedOut })
  $results | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $EvidenceRoot 'processes.json')
  Get-Content -LiteralPath $out
  Get-Content -LiteralPath $err
  if ($timedOut) { throw "$Name timed out; owned process tree terminated" }
  if ($null -eq $code) { throw "$Name has no observable exit status" }
  if ($code -ne 0) { throw "$Name exited with status $code" }
}
$cleanupSafe = $false
$profileRoot = Join-Path $env:APPDATA $product
$createdProfileRoot = -not (Test-Path -LiteralPath $profileRoot)
$profileMarker = Join-Path $profileRoot ('.installer-probe-' + [Guid]::NewGuid().ToString('N'))
$profileValue = [Guid]::NewGuid().ToString('N')
$oldEnvironment = @{}
$keys = @('MYOXUS_ELECTRON_EXECUTABLE', 'MYOXUS_ELECTRON_RELEASE_EVIDENCE', 'MYOXUS_RELEASE_PACKAGE_PATH', 'MYOXUS_RELEASE_VERSION', 'MYOXUS_RELEASE_CHANNEL', 'MYOXUS_RELEASE_PLATFORM', 'MYOXUS_RELEASE_ARCH', 'MYOXUS_RELEASE_FORMAT', 'MYOXUS_RELEASE_SOURCE_COMMIT')
foreach ($key in $keys) { $oldEnvironment[$key] = [Environment]::GetEnvironmentVariable($key) }
New-Item -ItemType Directory -Path $OwnedRoot | Out-Null
try {
  New-Item -ItemType Directory -Force -Path $profileRoot | Out-Null
  [IO.File]::WriteAllText($profileMarker, $profileValue)
  @($installer[0], $archive[0]) | ForEach-Object {
    @{ name = $_.Name; size = $_.Length; sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }
  } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $EvidenceRoot 'packages.json')
  # NSIS requires the unquoted /D= remainder last; never elevate this probe to AllUsers.
  Invoke-OwnedProcess 'install' $installer[0].FullName @('/S', '/CurrentUser', "/D=$nsisRoot") 600000
  $registration = Get-ItemProperty -LiteralPath "HKCU:\Software\$guid"
  if ([IO.Path]::GetFullPath($registration.InstallLocation) -ne $nsisRoot) { throw 'Installer registered an unexpected path' }
  $cleanupSafe = $true
  Expand-Archive -LiteralPath $archive[0].FullName -DestinationPath $zipRoot
  if ((Get-Content -LiteralPath (Join-Path $nsisRoot 'resources/package-type') -Raw).Trim() -ne 'nsis') { throw 'NSIS package marker missing' }
  $portable = @(Get-ChildItem -LiteralPath $zipRoot -Recurse -File -Filter "$product.exe")
  if ($portable.Count -ne 1) { throw 'Portable executable is ambiguous or missing' }
  $executables = @{ nsis = (Join-Path $nsisRoot "$product.exe"); zip = $portable[0].FullName }
  foreach ($format in @('nsis', 'zip')) {
    $executable = $executables[$format]
    if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw "$format executable missing" }
    $actualVersion = (Get-Item -LiteralPath $executable).VersionInfo.ProductVersion
    if ($actualVersion -ne $Version) { throw "$format executable version mismatch: $actualVersion, expected $Version" }
    if ($format -eq 'zip' -and (Test-Path -LiteralPath (Join-Path (Split-Path $executable) 'resources/package-type'))) { throw 'Portable ZIP must not advertise a native package updater' }
    $env:MYOXUS_ELECTRON_EXECUTABLE = $executable
    $env:MYOXUS_ELECTRON_RELEASE_EVIDENCE = Join-Path $EvidenceRoot $format
    $env:MYOXUS_RELEASE_PACKAGE_PATH = if ($format -eq 'nsis') { $installer[0].FullName } else { $archive[0].FullName }
    $env:MYOXUS_RELEASE_VERSION = $Version
    $env:MYOXUS_RELEASE_CHANNEL = $Channel
    $env:MYOXUS_RELEASE_PLATFORM = 'windows'
    $env:MYOXUS_RELEASE_ARCH = 'x64'
    $env:MYOXUS_RELEASE_FORMAT = $format
    $env:MYOXUS_RELEASE_SOURCE_COMMIT = $env:GITHUB_SHA
    # Existing smoke owns native bindings, CSP and same-profile restart readback.
    $yarn = (Resolve-Path '.yarn/releases/yarn-4.18.0.cjs').Path
    Invoke-OwnedProcess "runtime-$format" (Get-Command node).Source @("`"$yarn`"", 'playwright', 'test', 'tests/client/desktop/electron/e2e/release-smoke.spec.ts', '--config', 'tests/client/desktop/electron/playwright.config.ts', '--grep', '"attests native runtime, CSP, offline fonts and restart persistence"', '--workers=1', '--reporter=list') 600000
  }
}
finally {
  foreach ($key in $keys) { [Environment]::SetEnvironmentVariable($key, $oldEnvironment[$key]) }
  $uninstaller = Join-Path $nsisRoot 'Uninstall.exe'
  # A failed install may still register its path. Never trust a filename alone.
  $key = "HKCU:\Software\$guid"
  if (Test-Path -LiteralPath $key) {
    $location = (Get-ItemProperty -LiteralPath $key).InstallLocation
    if ([IO.Path]::GetFullPath($location) -ne $nsisRoot) { throw 'Cleanup refuses changed/foreign registration; installation retained' }
    if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) { throw 'Owned uninstaller missing; installation retained' }
    Invoke-OwnedProcess 'uninstall' $uninstaller @('/S', '/CurrentUser', "_?=$nsisRoot") 60000
    $cleanupSafe = $true
  }
  foreach ($key in $registry) {
    if (Test-Path -LiteralPath $key) { throw "Cleanup left registration; installation retained: $key" }
  }
  if (-not (Test-Path -LiteralPath $profileMarker) -or [IO.File]::ReadAllText($profileMarker) -ne $profileValue) { throw 'Install/uninstall did not preserve profile data' }
  Remove-Item -LiteralPath $profileMarker
  if ($createdProfileRoot -and -not (Get-ChildItem -LiteralPath $profileRoot -Force | Select-Object -First 1)) { Remove-Item -LiteralPath $profileRoot }
  if ($cleanupSafe) { Remove-Item -LiteralPath $OwnedRoot -Recurse -Force }
}
