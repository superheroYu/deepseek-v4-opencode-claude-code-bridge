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

escape_systemd_path() {
  printf '%s' "$1" | sed 's/%/%%/g'
}

proxy_environment_lines() {
  for name in HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy; do
    value=$(printenv "$name" 2>/dev/null || true)
    if [ -n "$value" ]; then
      printf 'Environment="%s=%s"\n' "$name" "$(escape_systemd_arg "$value")"
    fi
  done
}

has_proxy_environment() {
  for name in HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy; do
    value=$(printenv "$name" 2>/dev/null || true)
    if [ -n "$value" ]; then
      return 0
    fi
  done
  return 1
}

node_supports_env_proxy() {
  "$NODE_BIN" --help 2>/dev/null | grep -q -- "--use-env-proxy"
}

NODE_ENV_PROXY_ARG=""
PROXY_ENVIRONMENT_LINES=$(proxy_environment_lines)
if [ -n "$PROXY_ENVIRONMENT_LINES" ]; then
  if node_supports_env_proxy; then
    NODE_ENV_PROXY_ARG=" --use-env-proxy"
  else
    echo "Warning: proxy environment variables were found, but this Node.js version does not support --use-env-proxy." >&2
    echo "The systemd service will receive the proxy variables, but Node.js fetch may ignore them." >&2
  fi
fi

mkdir -p "$SERVICE_DIR"

cat > "$SERVICE_PATH" <<EOF
[Unit]
Description=DeepSeek V4 OpenCode Claude Code Bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$(escape_systemd_path "$REPO_DIR")
$PROXY_ENVIRONMENT_LINES
ExecStart="$(escape_systemd_arg "$NODE_BIN")"$NODE_ENV_PROXY_ARG "$(escape_systemd_arg "$REPO_DIR/server.js")" --config "$(escape_systemd_arg "$CONFIG_PATH")"
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
if has_proxy_environment; then
  echo "Proxy environment: captured from the current shell"
fi
echo
if command -v loginctl >/dev/null 2>&1; then
  LINGER=$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || true)
  if [ "$LINGER" != "yes" ]; then
    echo "This user service starts after the user session exists."
    echo "To start it at boot before login, run:"
    echo "  sudo loginctl enable-linger \"$USER\""
  fi
else
  echo "If you need it to start before the user logs in, enable systemd user lingering for this account."
fi
