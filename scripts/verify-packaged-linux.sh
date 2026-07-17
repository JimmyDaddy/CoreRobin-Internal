#!/usr/bin/env bash
set -euo pipefail

bundle_root=${1:?"Usage: verify-packaged-linux.sh BUNDLE_ROOT"}
shopt -s nullglob
debs=("$bundle_root"/deb/*.deb)
appimages=("$bundle_root"/appimage/*.AppImage)
if [[ ${#debs[@]} -ne 1 || ${#appimages[@]} -ne 1 ]]; then
  echo "Expected one DEB and one AppImage under $bundle_root." >&2
  exit 1
fi
appimage_path=$(realpath "${appimages[0]}")

work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT

dpkg-deb --info "${debs[0]}" >/dev/null
dpkg-deb --extract "${debs[0]}" "$work_dir/deb"
deb_binary=$(find "$work_dir/deb" -type f -name core-robin -perm -u+x -print -quit)
desktop_file=$(find "$work_dir/deb" -type f -path '*/applications/*.desktop' -print -quit)
test -n "$deb_binary"
test -n "$desktop_file"
file "$deb_binary" | grep -E 'ELF 64-bit.*x86-64'
grep -Eq '^Name=CoreRobin$' "$desktop_file"
grep -Eq '^Exec=.*core-robin' "$desktop_file"

mkdir "$work_dir/appimage"
(
  cd "$work_dir/appimage"
  chmod +x "$appimage_path"
  "$appimage_path" --appimage-extract >/dev/null
)
test -x "$work_dir/appimage/squashfs-root/AppRun"
appimage_binary=$(find "$work_dir/appimage/squashfs-root" -type f -name core-robin -perm -u+x -print -quit)
test -n "$appimage_binary"
file "$appimage_binary" | grep -E 'ELF 64-bit.*x86-64'

echo "Verified Linux installers: $(basename "${debs[0]}") and $(basename "$appimage_path")."
