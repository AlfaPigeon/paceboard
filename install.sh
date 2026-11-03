#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PORT="${STORYBOARD_PORT:-3200}"
APP_ID="storyboard"
UNIT_NAME="${APP_ID}.service"
DESKTOP_NAME="${APP_ID}.desktop"

echo "==> Storyboard install (Arch-oriented)"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing dependency: $1"
    echo "  hint: sudo pacman -S --needed $2"
    MISSING=1
  fi
}

MISSING=0
need_cmd node nodejs
need_cmd npm npm
need_cmd ffmpeg ffmpeg
need_cmd ffprobe ffmpeg
if [[ "$MISSING" -eq 1 ]]; then
  echo "Install the packages above, then re-run ./install.sh"
  exit 1
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  echo "Node 20+ required (found $(node -v))"
  exit 1
fi

echo "==> npm install"
cd "$ROOT"
npm install --omit=dev

mkdir -p "$ROOT/data"/{media,uploads,cache}
mkdir -p "$HOME/.config/systemd/user"
mkdir -p "$HOME/.local/share/applications"
mkdir -p "$HOME/.local/bin"

# Wrapper so the unit and desktop file can find the app
cat > "$HOME/.local/bin/storyboard" <<WRAP
#!/usr/bin/env bash
export STORYBOARD_PORT="\${STORYBOARD_PORT:-$PORT}"
cd "$ROOT"
exec node src/server.js
WRAP
chmod +x "$HOME/.local/bin/storyboard"

cat > "$HOME/.config/systemd/user/$UNIT_NAME" <<UNIT
[Unit]
Description=Storyboard local video ideation app
After=network.target

[Service]
Type=simple
WorkingDirectory=$ROOT
Environment=STORYBOARD_PORT=$PORT
Environment=NODE_ENV=production
ExecStart=$(command -v node) $ROOT/src/server.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
UNIT

cat > "$HOME/.local/share/applications/$DESKTOP_NAME" <<DESK
[Desktop Entry]
Name=Storyboard
Comment=YouTube storyboard and ideation canvas
Exec=xdg-open http://127.0.0.1:$PORT/
Icon=video-x-generic
Terminal=false
Type=Application
Categories=AudioVideo;Office;
StartupNotify=true
DESK

# Also keep copies in packaging/ for reference
mkdir -p "$ROOT/packaging"
cp "$HOME/.config/systemd/user/$UNIT_NAME" "$ROOT/packaging/$UNIT_NAME"
cp "$HOME/.local/share/applications/$DESKTOP_NAME" "$ROOT/packaging/$DESKTOP_NAME"

systemctl --user daemon-reload
systemctl --user enable --now "$UNIT_NAME" || true

echo
echo "Installed."
echo "  App:     $ROOT"
echo "  Service: systemctl --user status $UNIT_NAME"
echo "  Open:    http://127.0.0.1:$PORT/"
echo "  Desktop: $HOME/.local/share/applications/$DESKTOP_NAME"
echo
echo "If the service failed to start in this environment, run: npm start"
