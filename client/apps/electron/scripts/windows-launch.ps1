# SPDX-License-Identifier: AGPL-3.0-or-later
param([Parameter(Mandatory = $true)][string]$Application, [switch]$Updated)
$ErrorActionPreference = "Stop"
# The interactive desktop shell launches the app with the user's token even
# when a per-machine installer is elevated. Do not inherit installer privileges.
$shell = New-Object -ComObject Shell.Application
$arguments = if ($Updated) { "--updated" } else { "" }
$shell.ShellExecute($Application, $arguments, [IO.Path]::GetDirectoryName($Application), "open", 1)
