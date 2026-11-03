#!/usr/bin/env bash
set -euo pipefail

APP_ID="storyboard"
UNIT_NAME="${APP_ID}.service"
DESKTOP_NAME="${APP_ID}.desktop"

systemctl --user disable --now "$UNIT_NAME" 2>/dev/null || true
rm -f "$HOME/.config/systemd/user/$UNIT_NAME"
rm -f "$HOME/.local/share/applications/$DESKTOP_NAME"
rm -f "$HOME/.local/bin/storyboard"
systemctl --user daemon-reload 2>/dev/null || true

echo "Storyboard user service and launcher removed."
echo "Project files were left in place; delete the repo folder manually if desired."
echo "Local data/ (including Notion token) was not deleted."
