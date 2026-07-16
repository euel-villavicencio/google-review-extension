#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(dirname "$script_dir")"
zip_path="$root/google-review-settings-widget.zip"
package_root="$root/zoho-widget-package"
app_index="$package_root/app/index.html"
app_widget="$package_root/app/widget.html"
app_dashboard="$package_root/app/dashboard.html"

if [ -f "$app_index" ]; then
  cp -f "$app_index" "$app_widget"
  cp -f "$app_index" "$app_dashboard"
fi

if [ -f "$zip_path" ]; then
  rm -f "$zip_path"
fi

# Connected Apps expects the hosted app bundle only. The project manifest is
# used by ZET validation but must not be included in the replacement ZIP.
(cd "$package_root" && zip -r "$zip_path" app)

ls -la "$zip_path"