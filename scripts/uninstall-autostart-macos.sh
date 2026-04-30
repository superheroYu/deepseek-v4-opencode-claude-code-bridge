#!/usr/bin/env sh
set -eu

LABEL="${LABEL:-com.deepseek-v4-opencode-claude-code-bridge}"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null || true
launchctl unload "$PLIST_PATH" 2>/dev/null || true
rm -f "$PLIST_PATH"

echo "Removed LaunchAgent: $LABEL"
