#!/usr/bin/env bash

set -euo pipefail

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${RELEASE_COMMIT:?RELEASE_COMMIT is required}"
: "${RELEASE_VERSION:?RELEASE_VERSION is required}"

if [[ ! "$RELEASE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Release version must use MAJOR.MINOR.PATCH: $RELEASE_VERSION" >&2
  exit 1
fi

if [[ ! "$RELEASE_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Release commit must be a full lowercase Git SHA: $RELEASE_COMMIT" >&2
  exit 1
fi

release_tag="v$RELEASE_VERSION"
release_ref="refs/tags/$release_tag"
existing_sha="$(
  gh api "repos/$GITHUB_REPOSITORY/git/matching-refs/tags/$release_tag" \
    --jq ".[] | select(.ref == \"$release_ref\") | .object.sha"
)"

if [[ -n "$existing_sha" ]]; then
  if [[ "$existing_sha" != "$RELEASE_COMMIT" ]]; then
    echo "Stable tag $release_tag points to $existing_sha, expected $RELEASE_COMMIT." >&2
    exit 1
  fi

  echo "Stable tag $release_tag already points to the verified candidate commit."
  exit 0
fi

gh api --method POST "repos/$GITHUB_REPOSITORY/git/refs" \
  -f ref="$release_ref" \
  -f sha="$RELEASE_COMMIT" >/dev/null
echo "Created stable tag $release_tag at $RELEASE_COMMIT."
