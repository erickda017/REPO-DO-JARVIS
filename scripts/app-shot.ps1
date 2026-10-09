# Verification helper: launch the built app, run an optional page script, save a screenshot.
# Usage: pwsh scripts/app-shot.ps1 -Out .impeccable/review/home.png [-Exec "<js>"] [-Delay 9000]
param([string]$Out, [string]$Exec = '', [int]$Delay = 9000, [string]$Size = '')
$root = Split-Path $PSScriptRoot -Parent
$env:APP_SHOT = (Resolve-Path (Split-Path $Out -Parent)).Path + '\' + (Split-Path $Out -Leaf)
$env:APP_SHOT_DELAY = "$Delay"
if ($Exec) { $env:APP_EXEC = $Exec }
Start-Process -FilePath "$root\node_modules\electron\dist\electron.exe" -ArgumentList '.' -WorkingDirectory $root -Wait -WindowStyle Hidden
Remove-Item Env:APP_SHOT, Env:APP_SHOT_DELAY, Env:APP_EXEC -ErrorAction SilentlyContinue
