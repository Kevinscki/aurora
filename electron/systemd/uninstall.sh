#!/usr/bin/env bash
set -euo pipefail

unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
unit_file="$unit_dir/aurora.service"

systemctl --user disable --now aurora.service 2>/dev/null || true

if [[ -f "$unit_file" ]]; then
  if ! grep -q '^Description=Aurora desktop assistant$' "$unit_file"; then
    echo "Refusing to remove an unrecognized service file: $unit_file" >&2
    exit 1
  fi
  rm -f "$unit_file"
fi

systemctl --user daemon-reload
systemctl --user reset-failed aurora.service 2>/dev/null || true
echo "Aurora autostart has been removed."
