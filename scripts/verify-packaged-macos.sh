#!/usr/bin/env bash
set -euo pipefail

bundle_root=${1:?"Usage: verify-packaged-macos.sh BUNDLE_ROOT EXPECTED_ARCH [IDENTIFIER] [TEAM_ID] [TRUST_MODE]"}
expected_arch=${2:?"Usage: verify-packaged-macos.sh BUNDLE_ROOT EXPECTED_ARCH [IDENTIFIER] [TEAM_ID] [TRUST_MODE]"}
expected_identifier=${3:-com.corerobin.monitor}
expected_team_id=${4:?"Expected Apple Developer Team ID"}
trust_mode=${5:-notarized}

if [[ $trust_mode != notarized && $trust_mode != signed-preview ]]; then
  echo "Unsupported macOS package trust mode: $trust_mode" >&2
  exit 1
fi

shopt -s nullglob
dmgs=("$bundle_root"/dmg/*.dmg)
if [[ ${#dmgs[@]} -ne 1 ]]; then
  echo "Expected exactly one DMG under $bundle_root/dmg; found ${#dmgs[@]}." >&2
  exit 1
fi
dmg_path=${dmgs[0]}

codesign --verify --strict --verbose=4 "$dmg_path"
dmg_signature=$(codesign -dv --verbose=4 "$dmg_path" 2>&1)
grep -F 'Authority=Developer ID Application:' <<<"$dmg_signature"
grep -F "($expected_team_id)" <<<"$dmg_signature"
if [[ $trust_mode == notarized ]]; then
  xcrun stapler validate "$dmg_path"
  spctl --assess --type open --context context:primary-signature --verbose=4 "$dmg_path"
fi

mount_dir=$(mktemp -d)
cleanup() {
  hdiutil detach -quiet "$mount_dir" >/dev/null 2>&1 || true
  rmdir "$mount_dir" >/dev/null 2>&1 || true
}
trap cleanup EXIT
hdiutil attach -quiet -readonly -nobrowse -mountpoint "$mount_dir" "$dmg_path"

apps=("$mount_dir"/*.app)
if [[ ${#apps[@]} -ne 1 ]]; then
  echo "Expected exactly one application in $dmg_path; found ${#apps[@]}." >&2
  exit 1
fi
app_path=${apps[0]}
info_plist="$app_path/Contents/Info.plist"
test -f "$info_plist"

identifier=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$info_plist")
executable_name=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$info_plist")
version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$info_plist")
test "$identifier" = "$expected_identifier"
test -n "$version"
test -x "$app_path/Contents/MacOS/$executable_name"

codesign --verify --deep --strict --verbose=4 "$app_path"
app_signature=$(codesign -dv --verbose=4 "$app_path" 2>&1)
grep -F 'Authority=Developer ID Application:' <<<"$app_signature"
grep -F "($expected_team_id)" <<<"$app_signature"
grep -E '^flags=.*\(.*runtime.*\)' <<<"$app_signature"
grep -F 'Timestamp=' <<<"$app_signature"
if [[ $trust_mode == notarized ]]; then
  spctl --assess --type execute --verbose=4 "$app_path"
fi
test "$(lipo -archs "$app_path/Contents/MacOS/$executable_name")" = "$expected_arch"

if [[ $trust_mode == notarized ]]; then
  trust_description="Developer ID signed and notarized"
else
  trust_description="Developer ID signed Preview; notarization pending"
fi
echo "Verified macOS DMG: $(basename "$dmg_path") ($identifier, $version, $expected_arch, $trust_description)."
