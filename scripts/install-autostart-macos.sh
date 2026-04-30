#!/usr/bin/env sh
set -eu

LABEL="${LABEL:-com.deepseek-v4-opencode-claude-code-bridge}"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
CONFIG_PATH="${CONFIG_PATH:-$REPO_DIR/config.json}"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs"

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

xml_escape() {
  sed \
    -e 's/&/\&amp;/g' \
    -e 's/</\&lt;/g' \
    -e 's/>/\&gt;/g' \
    -e 's/"/\&quot;/g'
}

mkdir -p "$PLIST_DIR" "$LOG_DIR"

NODE_XML=$(printf '%s' "$NODE_BIN" | xml_escape)
SERVER_XML=$(printf '%s' "$REPO_DIR/server.js" | xml_escape)
CONFIG_XML=$(printf '%s' "$CONFIG_PATH" | xml_escape)
REPO_XML=$(printf '%s' "$REPO_DIR" | xml_escape)
OUT_XML=$(printf '%s' "$LOG_DIR/$LABEL.log" | xml_escape)
ERR_XML=$(printf '%s' "$LOG_DIR/$LABEL.error.log" | xml_escape)

cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_XML</string>
    <string>$SERVER_XML</string>
    <string>--config</string>
    <string>$CONFIG_XML</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$REPO_XML</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$OUT_XML</string>
  <key>StandardErrorPath</key>
  <string>$ERR_XML</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null || true
if ! launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null; then
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  launchctl load -w "$PLIST_PATH"
fi
launchctl enable "gui/$(id -u)/$LABEL" 2>/dev/null || true

echo "Installed and started LaunchAgent: $LABEL"
echo "Node: $NODE_BIN"
echo "Config: $CONFIG_PATH"
echo "Logs: $LOG_DIR/$LABEL.log"
