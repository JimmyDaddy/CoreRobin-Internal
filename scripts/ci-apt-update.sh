#!/usr/bin/env bash

set -euo pipefail

apt_options=(
  -o Acquire::Retries=2
  -o Acquire::http::Timeout=20
  -o Acquire::https::Timeout=20
)

for source_file in \
  /etc/apt/sources.list \
  /etc/apt/apt-mirrors.txt \
  /etc/apt/sources.list.d/*.list \
  /etc/apt/sources.list.d/*.sources; do
  if [[ -f "$source_file" ]]; then
    sudo sed -i -E \
      's#https?://azure\.archive\.ubuntu\.com/ubuntu/?#http://archive.ubuntu.com/ubuntu/#g' \
      "$source_file"
  fi
done

echo "Using the canonical Ubuntu archive instead of the runner's latency-sensitive Azure mirror." >&2
sudo apt-get "${apt_options[@]}" update
