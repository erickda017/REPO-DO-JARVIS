# Verification helper: launch the built app, run an optional page script, save a screenshot.
# Usage: powershell -File scripts/app-shot.ps1 -Out .impeccable/review/home.png [-Exec "<js, no double quotes>"] [-Delay 9000]
param([string]$Out, [string]$Exec = '', [int]$Delay = 9000)
$root = Split-Path $PSScriptRoot -Parent
$env:APP_SHOT = (Resolve-Path (Split-Path $Out -Parent)).Path + '\' + (Split-Path $Out -Leaf)
$env:APP_SHOT_DELAY = "$Delay"
if ($Exec) { $env:APP_EXEC = $Exec }
# Wait for the app process only: `-Wait` would also wait for the local AI servers the app can start.
$p = Start-Process -FilePath "$root\node_modules\electron\dist\electron.exe" -ArgumentList '.' -WorkingDirectory $root -PassThru -WindowStyle Hidden
$p.WaitForExit()
