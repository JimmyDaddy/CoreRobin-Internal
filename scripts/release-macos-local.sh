#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

tag=${1:-}
upload=true
if [[ ${2:-} == "--no-upload" ]]; then
  upload=false
elif [[ -n ${2:-} ]]; then
  echo "Usage: scripts/release-macos-local.sh vMAJOR.MINOR.PATCH [--no-upload]" >&2
  exit 2
fi
if [[ ! $tag =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Usage: scripts/release-macos-local.sh vMAJOR.MINOR.PATCH [--no-upload]" >&2
  exit 2
fi
if [[ $(uname -s) != Darwin ]]; then
  echo "Local macOS release builds must run on macOS." >&2
  exit 1
fi

for command in git node pnpm rustup security xcrun gh; do
  command -v "$command" >/dev/null || { echo "Missing required command: $command" >&2; exit 1; }
done
if [[ -n $(git status --porcelain) ]]; then
  echo "The release worktree must be clean before building local macOS assets." >&2
  exit 1
fi

git fetch origin main --tags
node scripts/verify-release-source.mjs "$tag" origin/main
release_commit=$(git rev-parse "${tag}^{commit}")
if [[ $(git rev-parse HEAD) != "$release_commit" ]]; then
  echo "HEAD must point at $tag ($release_commit) before the local release build." >&2
  exit 1
fi

identity=${APPLE_SIGNING_IDENTITY:-}
if [[ -z $identity ]]; then
  identity=$(security find-identity -v -p codesigning \
    | sed -nE 's/^.*"(Developer ID Application:[^"]+)".*$/\1/p' \
    | head -n 1)
fi
if [[ -z $identity ]] || ! security find-identity -v -p codesigning | grep -Fq "\"$identity\""; then
  echo "A valid Developer ID Application identity is required in the login keychain." >&2
  exit 1
fi
team_id=${APPLE_TEAM_ID:-$(printf '%s\n' "$identity" | sed -nE 's/^.*\(([A-Z0-9]{10})\)$/\1/p')}
if [[ ! $team_id =~ ^[A-Z0-9]{10}$ ]]; then
  echo "Unable to derive a valid Apple Team ID from the signing identity." >&2
  exit 1
fi

notary_profile=${COREROBIN_NOTARY_PROFILE:-CoreRobin-Notary}
updater_key=${TAURI_SIGNING_PRIVATE_KEY_PATH:-$HOME/.tauri/corerobin-updater.key}
updater_password_service=${COREROBIN_UPDATER_PASSWORD_SERVICE:-CoreRobin Tauri Updater}
test -s "$updater_key" || { echo "Missing Tauri updater private key: $updater_key" >&2; exit 1; }
xcrun notarytool history --keychain-profile "$notary_profile" --output-format json >/dev/null
updater_password=$(security find-generic-password -a "$USER" -s "$updater_password_service" -w)
test -n "$updater_password" || { echo "The Tauri updater key password is empty." >&2; exit 1; }
trap 'unset updater_password TAURI_SIGNING_PRIVATE_KEY_PASSWORD' EXIT

export APPLE_SIGNING_IDENTITY="$identity"
export TAURI_SIGNING_PRIVATE_KEY="$updater_key"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$updater_password"

rustup target add aarch64-apple-darwin x86_64-apple-darwin
pnpm install --frozen-lockfile
pnpm release:gate:static

version=${tag#v}
build_stamp=$(date -u +%Y%m%dT%H%M%SZ)
output_root=${COREROBIN_MACOS_OUTPUT_DIR:-$repo_root/.local-dev/release-macos/$tag/$build_stamp}
mkdir -p "$output_root"

find_one() {
  local directory=$1
  local pattern=$2
  local description=$3
  local matches
  matches=$(find "$directory" -maxdepth 1 -type f -name "$pattern" -print | sort)
  if [[ $(printf '%s\n' "$matches" | sed '/^$/d' | wc -l | tr -d ' ') != 1 ]]; then
    echo "Expected exactly one $description in $directory; found:" >&2
    printf '%s\n' "$matches" >&2
    exit 1
  fi
  printf '%s\n' "$matches"
}

build_target() {
  local target=$1
  local expected_arch=$2
  local public_arch=$3
  local bundle_root="src-tauri/target/$target/release/bundle"

  pnpm tauri build --target "$target" --bundles app,dmg -- --locked

  local dmg
  local updater_package
  local updater_signature
  dmg=$(find_one "$bundle_root/dmg" "CoreRobin_${version}_*.dmg" "$target DMG")
  updater_package=$(find_one "$bundle_root/macos" "*.app.tar.gz" "$target updater package")
  updater_signature=$(find_one "$bundle_root/macos" "*.app.tar.gz.sig" "$target updater signature")

  xcrun notarytool submit "$dmg" --keychain-profile "$notary_profile" --wait
  xcrun stapler staple "$dmg"
  bash scripts/verify-packaged-macos.sh \
    "$bundle_root" \
    "$expected_arch" \
    "com.corerobin.monitor" \
    "$team_id"

  cp "$dmg" "$output_root/CoreRobin_${version}_${public_arch}.dmg"
  cp "$updater_package" "$output_root/CoreRobin_${version}_${public_arch}.app.tar.gz"
  cp "$updater_signature" "$output_root/CoreRobin_${version}_${public_arch}.app.tar.gz.sig"
}

build_target aarch64-apple-darwin arm64 aarch64
build_target x86_64-apple-darwin x86_64 x64
node scripts/local-macos-release-manifest.mjs create \
  "$tag" \
  "$release_commit" \
  "$team_id" \
  "$output_root"
node scripts/local-macos-release-manifest.mjs verify "$tag" "$release_commit" "$output_root"

if [[ $upload == true ]]; then
  notes_file=$(mktemp "${TMPDIR:-/tmp}/corerobin-release-notes.XXXXXX")
  trap 'rm -f "${notes_file:-}"; unset updater_password TAURI_SIGNING_PRIVATE_KEY_PASSWORD' EXIT
  node scripts/render-release-notes.mjs "$tag" --output "$notes_file"

  if gh release view "$tag" --repo JimmyDaddy/corerobin-monitor >/dev/null 2>&1; then
    if [[ $(gh release view "$tag" --json isDraft --jq .isDraft --repo JimmyDaddy/corerobin-monitor) != true ]]; then
      echo "Refusing to replace macOS assets on an already published release: $tag" >&2
      exit 1
    fi
  else
    gh release create "$tag" \
      --draft \
      --target main \
      --title "CoreRobin $tag" \
      --notes-file "$notes_file" \
      --repo JimmyDaddy/corerobin-monitor
  fi
  gh release upload "$tag" "$output_root"/* \
    --clobber \
    --repo JimmyDaddy/corerobin-monitor
  gh release edit "$tag" \
    --notes-file "$notes_file" \
    --repo JimmyDaddy/corerobin-monitor
fi

printf 'Local macOS release assets are ready at %s\n' "$output_root"
if [[ $upload == true ]]; then
  printf 'Push %s to origin, or rerun the Release workflow on that tag with macos_builder=local.\n' "$tag"
fi
