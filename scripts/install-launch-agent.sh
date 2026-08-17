#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
PLIST="$HOME/Library/LaunchAgents/com.shahbazi.github-control-center.plist"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.github-control-center"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.shahbazi.github-control-center</string>
<key>ProgramArguments</key><array><string>$NODE</string><string>$ROOT/src/server.mjs</string></array>
<key>WorkingDirectory</key><string>$ROOT</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>$HOME/.github-control-center/server.log</string>
<key>StandardErrorPath</key><string>$HOME/.github-control-center/server.err.log</string>
</dict></plist>
PLIST
launchctl unload "$PLIST" >/dev/null 2>&1 || true
launchctl load "$PLIST"
echo "Installed. Dashboard: http://127.0.0.1:3010"
