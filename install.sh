#!/usr/bin/env bash
# Paceboard installer (Arch-oriented). Safe to run from a clone, or:
#   curl -fsSL https://raw.githubusercontent.com/AlfaPigeon/paceboard/main/install.sh | bash
set -euo pipefail

REPO_URL="${PACEBOARD_REPO:-https://github.com/AlfaPigeon/paceboard.git}"
REPO_BRANCH="${PACEBOARD_BRANCH:-main}"
PORT="${PACEBOARD_PORT:-3200}"
APP_ID="paceboard"
UNIT_NAME="${APP_ID}.service"
DESKTOP_NAME="${APP_ID}.desktop"
DATA_HOME="${PACEBOARD_DATA:-$HOME/.local/share/paceboard}"

resolve_root() {
  # Prefer the directory that contains this script when it is a real file in a clone.
  if [[ -n "${BASH_SOURCE[0]:-}" && "${BASH_SOURCE[0]}" != "-" && -f "${BASH_SOURCE[0]}" ]]; then
    local d
    d="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    if [[ -f "$d/package.json" ]]; then
      echo "$d"
      return
    fi
  fi
  # Already inside a checkout
  if [[ -f ./package.json ]] && grep -q '"name": "paceboard"' ./package.json 2>/dev/null; then
    pwd
    return
  fi
  # curl | bash (or missing checkout): clone into ~/paceboard (override with PACEBOARD_DIR)
  local dest="${PACEBOARD_DIR:-$HOME/paceboard}"
  if [[ ! -d "$dest/.git" ]]; then
    echo "==> Cloning Paceboard into $dest"
    git clone --branch "$REPO_BRANCH" --depth 1 "$REPO_URL" "$dest"
  else
    echo "==> Using existing clone at $dest"
  fi
  echo "$dest"
}

ROOT="$(resolve_root)"
cd "$ROOT"

echo "==> Paceboard install (Arch-oriented)"
echo "    Root: $ROOT"
echo "    Data: $DATA_HOME"

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
need_cmd git git
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
npm install --omit=dev

mkdir -p "$DATA_HOME"/{media,uploads,cache}
mkdir -p "$HOME/.config/systemd/user"
mkdir -p "$HOME/.local/share/applications"
mkdir -p "$HOME/.local/bin"

# Dev convenience: keep a local ./data symlink-or-dir for gitignored scratch when running from source
mkdir -p "$ROOT/data"/{media,uploads,cache}

cat > "$HOME/.local/bin/paceboard" <<WRAP
#!/usr/bin/env bash
export PACEBOARD_PORT="\${PACEBOARD_PORT:-$PORT}"
export PACEBOARD_DATA="\${PACEBOARD_DATA:-$DATA_HOME}"
cd "$ROOT"
exec node src/server.js
WRAP
chmod +x "$HOME/.local/bin/paceboard"

cat > "$HOME/.config/systemd/user/$UNIT_NAME" <<UNIT
[Unit]
Description=Paceboard local YouTube planning app
After=network.target

[Service]
Type=simple
WorkingDirectory=$ROOT
Environment=PACEBOARD_PORT=$PORT
Environment=PACEBOARD_DATA=$DATA_HOME
Environment=NODE_ENV=production
ExecStart=$(command -v node) $ROOT/src/server.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
UNIT

cat > "$HOME/.local/share/applications/$DESKTOP_NAME" <<DESK
[Desktop Entry]
Name=Paceboard
Comment=Plan YouTube videos before you edit
Exec=xdg-open http://127.0.0.1:$PORT/
Icon=video-x-generic
Terminal=false
Type=Application
Categories=AudioVideo;Office;
StartupNotify=true
DESK

# Packaging templates under packaging/ stay portable (%h/paceboard); do not overwrite them
# with machine-specific generated units.
# Drop legacy Storyboard unit names if present from earlier installs
rm -f "$HOME/.config/systemd/user/storyboard.service" \
      "$HOME/.local/share/applications/storyboard.desktop" \
      "$HOME/.local/bin/storyboard" 2>/dev/null || true

systemctl --user daemon-reload 2>/dev/null || true
systemctl --user enable --now "$UNIT_NAME" 2>/dev/null || true

echo
echo "Installed."
echo "  App:     $ROOT"
echo "  Data:    $DATA_HOME"
echo "  Service: systemctl --user status $UNIT_NAME"
echo "  Open:    http://127.0.0.1:$PORT/"
echo "  Desktop: $HOME/.local/share/applications/$DESKTOP_NAME"
echo "  CLI:     paceboard   (or: npm start)"
echo
echo "If the user service failed to start in this environment, run: npm start"
