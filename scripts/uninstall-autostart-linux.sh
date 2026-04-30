#!/usr/bin/env sh
set -eu

SERVICE_NAME="${SERVICE_NAME:-deepseek-v4-opencode-claude-code-bridge.service}"
SERVICE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE_PATH="$SERVICE_DIR/$SERVICE_NAME"

systemctl --user disable --now "$SERVICE_NAME" 2>/dev/null || true
rm -f "$SERVICE_PATH"
systemctl --user daemon-reload

echo "Removed systemd user service: $SERVICE_NAME"
