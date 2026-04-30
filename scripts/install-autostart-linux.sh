#!/usr/bin/env sh
set -eu

SERVICE_NAME="${SERVICE_NAME:-deepseek-v4-opencode-claude-code-bridge.service}"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
CONFIG_PATH="${CONFIG_PATH:-$REPO_DIR/config.json}"
SERVICE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE_PATH="$SERVICE_DIR/$SERVICE_NAME"

if [ -z "${NODE_BIN:-}" ]; then
  NODE_BIN=$(command -v node || true)
fi

if [ -z "$NODE_BIN" ]; then
  echo "node executable not found. Install Node.js or set NODE_BIN=/path/to/node." >&2
  exit 1
fi

if [ ! -f "$CONFIG_PATH" ]; then
  echo "Config file not found: $CONFIG_PATH" >&2
  exit 1
fi

escape_systemd_arg() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/%/%%/g'
}

mkdir -p "$SERVICE_DIR"

cat > "$SERVICE_PATH" <<EOF
[Unit]
Description=DeepSeek V4 OpenCode Claude Code Bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory="$(escape_systemd_arg "$REPO_DIR")"
ExecStart="$(escape_systemd_arg "$NODE_BIN")" "$(escape_systemd_arg "$REPO_DIR/server.js")" --config "$(escape_systemd_arg "$CONFIG_PATH")"
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now "$SERVICE_NAME"

echo "Installed and started systemd user service: $SERVICE_NAME"
echo "Node: $NODE_BIN"
echo "Config: $CONFIG_PATH"
echo
echo "If you need it to start before the user logs in, run:"
echo "  sudo loginctl enable-linger \"$USER\""
