#!/usr/bin/env bash
set -uo pipefail
if [ "$(uname -s)" = "Darwin" ]; then
  APP_DIR="$HOME/Library/Application Support/BranaVPN"; BASE="$HOME/Library/Application Support"
  TARGETS=("Google/Chrome" "Google/Chrome Beta" "Google/Chrome Dev" "Google/Chrome Canary" "Chromium" "Microsoft Edge" "Microsoft Edge Beta" "Microsoft Edge Dev" "BraveSoftware/Brave-Browser" "Vivaldi" "Arc/User Data")
else
  APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/brana-vpn"; BASE="${XDG_CONFIG_HOME:-$HOME/.config}"
  TARGETS=("google-chrome" "google-chrome-beta" "google-chrome-unstable" "chromium" "microsoft-edge" "microsoft-edge-beta" "microsoft-edge-dev" "BraveSoftware/Brave-Browser" "vivaldi")
fi
for t in "${TARGETS[@]}"; do rm -f "$BASE/$t/NativeMessagingHosts/com.brana.vpn.json"; done
rm -rf "$APP_DIR"
echo "已卸载 Brana VPN 本地核心。"
