# SPDX-License-Identifier: AGPL-3.0-or-later

$ErrorActionPreference = "Stop"

if ($env:OS -ne "Windows_NT") {
  throw "Windows runner required"
}

$nodeVersion = "26.10.0"
$nodeArchiveSha256 =
  "9fef7eca6743a6b910989cd8e78712376b394fcb9b6e1e9c44a0799a287f90c5"
$corepackVersion = "0.36.0"
$yarnVersion = "4.18.0"
$myoxusTools = Join-Path $env:LOCALAPPDATA "Myoxus"
$nodeRoot = Join-Path $myoxusTools "Node"
$nodeCurrent = Join-Path $nodeRoot "current"
$nodeTools = Join-Path $nodeRoot "tools"
$corepackHome = Join-Path $myoxusTools "Corepack"
$nodeExecutable = Join-Path $nodeCurrent "node.exe"
$npmExecutable = Join-Path $nodeCurrent "npm.cmd"
$corepackExecutable = Join-Path $nodeTools "corepack.cmd"
$yarnExecutable = Join-Path $nodeTools "yarn.cmd"

$currentNodeVersion = if (Test-Path -LiteralPath $nodeExecutable -PathType Leaf) {
  (& $nodeExecutable --version).Trim()
}
else {
  "missing"
}
if ($currentNodeVersion -ne "v$nodeVersion") {
  $temporaryRoot = if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) {
    $env:TEMP
  }
  else {
    $env:RUNNER_TEMP
  }
  $archive = Join-Path $temporaryRoot "node-v$nodeVersion-win-x64.zip"
  $extractRoot = Join-Path $temporaryRoot "myoxus-node-$nodeVersion"
  New-Item -ItemType Directory -Force -Path $nodeRoot | Out-Null
  $previousProgressPreference = $ProgressPreference
  try {
    $ProgressPreference = "SilentlyContinue"
    Invoke-WebRequest `
      -UseBasicParsing `
      -Uri "https://nodejs.org/dist/v$nodeVersion/node-v$nodeVersion-win-x64.zip" `
      -OutFile $archive
    $actualSha256 = (
      Get-FileHash -LiteralPath $archive -Algorithm SHA256
    ).Hash.ToLowerInvariant()
    if ($actualSha256 -ne $nodeArchiveSha256) {
      throw "Pinned Node archive SHA-256 mismatch"
    }
    if (Test-Path -LiteralPath $extractRoot) {
      Remove-Item -LiteralPath $extractRoot -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null
    Expand-Archive -LiteralPath $archive -DestinationPath $extractRoot -Force
    if (Test-Path -LiteralPath $nodeCurrent) {
      Remove-Item -LiteralPath $nodeCurrent -Recurse -Force
    }
    Move-Item `
      -LiteralPath (Join-Path $extractRoot "node-v$nodeVersion-win-x64") `
      -Destination $nodeCurrent
  }
  finally {
    $ProgressPreference = $previousProgressPreference
    Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
    Remove-Item `
      -LiteralPath $extractRoot `
      -Recurse `
      -Force `
      -ErrorAction SilentlyContinue
  }
}

New-Item -ItemType Directory -Force -Path $nodeTools,$corepackHome | Out-Null
$env:Path = "$nodeCurrent;$nodeTools;$env:Path"
& $nodeExecutable build/scripts/ci/verify-electron-updater-source.mjs --prepare
if ($LASTEXITCODE -ne 0) { throw "Reviewed updater snapshot preparation failed" }
$env:COREPACK_HOME = $corepackHome
$currentCorepackVersion = if (
  Test-Path -LiteralPath $corepackExecutable -PathType Leaf
) {
  (& $corepackExecutable --version).Trim()
}
else {
  "missing"
}
if ($currentCorepackVersion -ne $corepackVersion) {
  & $npmExecutable install --global --prefix $nodeTools "corepack@$corepackVersion"
  if ($LASTEXITCODE -ne 0) {
    throw "Corepack $corepackVersion installation failed"
  }
}
& $corepackExecutable enable --install-directory $nodeTools
if ($LASTEXITCODE -ne 0) {
  throw "Corepack enable failed"
}
& $corepackExecutable prepare "yarn@$yarnVersion" --activate
if ($LASTEXITCODE -ne 0) {
  throw "Yarn $yarnVersion activation failed"
}

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$retainedUserPath = @($userPath -split ";" | Where-Object {
  -not [string]::IsNullOrWhiteSpace($_) -and
  $_ -ne $nodeCurrent -and
  $_ -ne $nodeTools
})
[Environment]::SetEnvironmentVariable(
  "Path",
  (@($nodeCurrent,$nodeTools) + $retainedUserPath -join ";"),
  "User"
)
[Environment]::SetEnvironmentVariable("COREPACK_HOME", $corepackHome, "User")

$cargoHome = if ([string]::IsNullOrWhiteSpace($env:CARGO_HOME)) {
  Join-Path $env:USERPROFILE ".cargo"
}
else {
  $env:CARGO_HOME
}
$cargoBin = Join-Path $cargoHome "bin"
$cargoExecutable = Join-Path $cargoBin "cargo.exe"

$env:CARGO_HOME = $cargoHome
if (-not (Get-Command cargo.exe -ErrorAction SilentlyContinue) -and
    (Test-Path -LiteralPath $cargoExecutable -PathType Leaf)) {
  $env:Path = "$cargoBin;$env:Path"
}

if (-not (Get-Command rustup.exe -ErrorAction SilentlyContinue)) {
  $rustupVersion = "1.29.0"
  $rustupSha256 =
    "86478e53f769379d7f0ebfa7c9aa97cb76ca92233f79aa2cc0dbee2efaac73c7"
  $temporaryRoot = if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) {
    $env:TEMP
  }
  else {
    $env:RUNNER_TEMP
  }
  $rustupInit = Join-Path $temporaryRoot "rustup-init-$rustupVersion.exe"
  $rustupUrl =
    "https://static.rust-lang.org/rustup/archive/$rustupVersion/x86_64-pc-windows-msvc/rustup-init.exe"
  $previousProgressPreference = $ProgressPreference
  try {
    $ProgressPreference = "SilentlyContinue"
    Invoke-WebRequest -UseBasicParsing -Uri $rustupUrl -OutFile $rustupInit
    $actualSha256 = (
      Get-FileHash -LiteralPath $rustupInit -Algorithm SHA256
    ).Hash.ToLowerInvariant()
    if ($actualSha256 -ne $rustupSha256) {
      throw "Pinned rustup-init SHA-256 mismatch"
    }
    & $rustupInit -y --no-modify-path --profile minimal --default-toolchain none
    if ($LASTEXITCODE -ne 0) {
      throw "User-local rustup installation failed"
    }
  }
  finally {
    $ProgressPreference = $previousProgressPreference
    Remove-Item -LiteralPath $rustupInit -Force -ErrorAction SilentlyContinue
  }
  $env:Path = "$cargoBin;$env:Path"
}

foreach ($command in @("node", "yarn", "rustup", "rustc", "cargo")) {
  if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
    throw "$command is required on the Windows Electron runner"
  }
}

$nodeMajor = (node -p "process.versions.node.split('.')[0]").Trim()
$activeYarnVersion = (yarn --version).Trim()
if ($nodeMajor -ne "26") {
  throw "Node 26 is required, found $nodeMajor"
}
if ($activeYarnVersion -ne $yarnVersion) {
  throw "Yarn $yarnVersion is required, found $activeYarnVersion"
}

rustup toolchain install stable --profile minimal
if ($LASTEXITCODE -ne 0) {
  throw "Failed to install the stable Rust toolchain"
}
rustup default stable
if ($LASTEXITCODE -ne 0) {
  throw "Failed to select the stable Rust toolchain"
}

$rustVersionLine = rustc -Vv
if ($LASTEXITCODE -ne 0) {
  throw "Failed to read the active Rust compiler version"
}
$rustRelease = ($rustVersionLine | Where-Object { $_ -like "release:*" } | Select-Object -First 1) -replace "^release:\s*", ""
if ([string]::IsNullOrWhiteSpace($rustRelease)) {
  throw "Unable to determine the active Rust compiler release"
}

cargo metadata `
  --format-version 1 `
  --no-deps `
  --manifest-path client/libs/local-store/Cargo.toml |
  Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "Windows Electron Cargo metadata failed"
}

Write-Host "Windows Electron toolchain: Node $nodeVersion, Yarn $yarnVersion, Rust stable ($rustRelease)"
