# SPDX-License-Identifier: AGPL-3.0-or-later
param([Parameter(Mandatory = $true)][string]$ToolsDirectory)
$ErrorActionPreference = "Stop"
$version = "3.13"
$digest = "ba63dffc4410ee89193e1cb5a41989991bd77c61068da17e3156d136b7b0b3d8"
$compiler = Join-Path $ToolsDirectory "nsis-$version\Bin\makensis.exe"
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) {
  New-Item -ItemType Directory -Force -Path $ToolsDirectory | Out-Null
  $archive = Join-Path $ToolsDirectory "nsis-$version.zip"
  try {
    & curl.exe --fail --location --retry 2 --max-time 120 "https://downloads.sourceforge.net/project/nsis/NSIS%203/$version/nsis-$version.zip" --output $archive
    if ($LASTEXITCODE -ne 0) { throw "NSIS archive download failed" }
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $digest) {
      throw "NSIS archive SHA-256 mismatch"
    }
    Expand-Archive -LiteralPath $archive -DestinationPath $ToolsDirectory -Force
  }
  finally { Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue }
}
if ((& $compiler /VERSION).Trim() -ne "v$version") { throw "Unexpected NSIS compiler version" }
Write-Output $compiler
