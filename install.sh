#!/usr/bin/env bash
# Agent Island installer: daemon (user service) + GNOME Shell extension + OpenCode plugin.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UUID="agent-island@lynx"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"
PLUGIN_DIR="$HOME/.config/opencode/plugins"
UNIT_DIR="$HOME/.config/systemd/user"

echo "Agent Island -> $REPO"

# 1. daemon (user service)
mkdir -p "$UNIT_DIR"
sed "s#^ExecStart=.*#ExecStart=/usr/bin/python3 -u $REPO/daemon/agent_island_daemon.py#" \
    "$REPO/systemd/agent-island.service" > "$UNIT_DIR/agent-island.service"
systemctl --user daemon-reload
systemctl --user enable --now agent-island
echo "  daemon: installed and started"

# 2. GNOME Shell extension
mkdir -p "$EXT_DIR"
cp "$REPO/extension/extension.js" "$REPO/extension/metadata.json" "$REPO/extension/stylesheet.css" "$EXT_DIR/"
gsettings set org.gnome.shell disable-user-extensions false
if command -v gnome-extensions >/dev/null; then
    gnome-extensions enable "$UUID" 2>/dev/null || true
fi
echo "  extension: installed to $EXT_DIR"

# 3. OpenCode plugin
mkdir -p "$PLUGIN_DIR"
ln -sf "$REPO/plugin/agent-island.js" "$PLUGIN_DIR/agent-island.js"
echo "  plugin: linked to $PLUGIN_DIR/agent-island.js"

echo
echo "Done. Log out and back in for the GNOME extension to load (Wayland cannot hot-reload it)."
