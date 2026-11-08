#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
electron_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
project_root=$(CDPATH= cd -- "$electron_dir/.." && pwd)
template="$script_dir/aurora.service.in"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
unit_file="$unit_dir/aurora.service"
electron_bin="$electron_dir/node_modules/electron/dist/electron"
skip_install=0
dry_run=0

usage() {
  echo "Usage: $0 [--no-install] [--dry-run]"
  echo "  --no-install  Do not run npm ci or build the frontend."
  echo "  --dry-run     Print the generated unit without installing it."
}

while (($#)); do
  case "$1" in
    --no-install) skip_install=1 ;;
    --dry-run) dry_run=1; skip_install=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

for command in npm systemctl sed install mktemp; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required command not found: $command" >&2
    exit 1
  fi
done

if ((skip_install == 0)); then
  echo "Installing frontend dependencies..."
  npm --prefix "$project_root/frontend" ci
  echo "Installing Electron dependencies..."
  npm --prefix "$electron_dir" ci
  echo "Building the production frontend..."
  npm --prefix "$project_root/frontend" run build
fi

if [[ ! -x "$electron_bin" ]]; then
  echo "Electron is not installed at: $electron_bin" >&2
  echo "Run this installer without --no-install first." >&2
  exit 1
fi

# Escape replacement-sensitive characters before inserting absolute paths into
# the template. A literal percent must be doubled so systemd does not treat it
# as a unit specifier.
escape_value() {
  printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g' -e 's/%/%%/g' -e 's/"/\\"/g'
}

escaped_electron_dir=$(escape_value "$electron_dir")
escaped_electron_bin=$(escape_value "$electron_bin")

render_unit() {
  sed \
    -e "s|@ELECTRON_DIR@|$escaped_electron_dir|g" \
    -e "s|@ELECTRON_BIN@|$escaped_electron_bin|g" \
    "$template"
}

if ((dry_run == 1)); then
  render_unit
  exit 0
fi

tmp_unit=$(mktemp)
trap 'rm -f "$tmp_unit"' EXIT
render_unit >"$tmp_unit"
install -Dm0644 "$tmp_unit" "$unit_file"

systemctl --user daemon-reload
systemctl --user enable --now aurora.service

echo
echo "Aurora now starts with your graphical login."
echo "Installed unit: $unit_file"
systemctl --user --no-pager --full status aurora.service || true
