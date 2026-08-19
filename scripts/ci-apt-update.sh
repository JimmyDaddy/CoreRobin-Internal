#!/usr/bin/env bash

set -euo pipefail

apt_options=(
  -o Acquire::Retries=2
  -o Acquire::http::Timeout=20
  -o Acquire::https::Timeout=20
)

if sudo apt-get "${apt_options[@]}" update; then
  exit 0
fi

echo "The runner's Azure Ubuntu mirror is unavailable; retrying with the canonical archive mirror." >&2

for source_file in \
  /etc/apt/sources.list \
  /etc/apt/sources.list.d/*.list \
  /etc/apt/sources.list.d/*.sources; do
  if [[ -f "$source_file" ]]; then
    sudo sed -i -E \
      's#https?://azure\.archive\.ubuntu\.com/ubuntu/?#http://archive.ubuntu.com/ubuntu/#g' \
      "$source_file"
  fi
done

sudo apt-get "${apt_options[@]}" update
