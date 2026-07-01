$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$zip = Join-Path $root "google-review-settings-widget.zip"
$packageRoot = Join-Path $root "zoho-widget-package"
$appIndex = Join-Path $packageRoot "app\index.html"
$appWidget = Join-Path $packageRoot "app\widget.html"
$appDashboard = Join-Path $packageRoot "app\dashboard.html"

if (Test-Path -LiteralPath $appIndex) {
  Copy-Item -LiteralPath $appIndex -Destination $appWidget -Force
  Copy-Item -LiteralPath $appIndex -Destination $appDashboard -Force
}

if (Test-Path -LiteralPath $zip) {
  Remove-Item -LiteralPath $zip -Force
}

# Connected Apps expects the hosted app bundle only. The project manifest is
# used by ZET validation but must not be included in the replacement ZIP.
Compress-Archive -Path (Join-Path $packageRoot "app") -DestinationPath $zip -Force
Get-Item -LiteralPath $zip | Select-Object FullName, Length, LastWriteTime
