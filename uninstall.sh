#!/usr/bin/env bash
set -euo pipefail

APP_ID="paceboard"
UNIT_NAME="${APP_ID}.service"
DESKTOP_NAME="${APP_ID}.desktop"

systemctl --user disable --now "$UNIT_NAME" 2>/dev/null || true
# Also clear legacy Storyboard unit if present
systemctl --user disable --now storyboard.service 2>/dev/null || true
rm -f "$HOME/.config/systemd/user/$UNIT_NAME" \
      "$HOME/.config/systemd/user/storyboard.service"
rm -f "$HOME/.local/share/applications/$DESKTOP_NAME" \
      "$HOME/.local/share/applications/storyboard.desktop"
rm -f "$HOME/.local/bin/paceboard" "$HOME/.local/bin/storyboard"
systemctl --user daemon-reload 2>/dev/null || true

echo "Paceboard user service and launcher removed."
echo "Project files were left in place; delete the repo folder manually if desired."
echo "Local data (~/.local/share/paceboard and ./data/, including Notion token) was not deleted."
