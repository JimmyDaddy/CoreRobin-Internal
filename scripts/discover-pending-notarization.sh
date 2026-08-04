#!/usr/bin/env bash

set -euo pipefail

GH_BIN="${GH_BIN:-gh}"
REQUESTED_TAG="${REQUESTED_TAG:-}"
REQUESTED_RUN_ID="${REQUESTED_RUN_ID:-}"

: "${GITHUB_EVENT_NAME:?GITHUB_EVENT_NAME is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
: "${PUBLIC_RELEASE_REPOSITORY:?PUBLIC_RELEASE_REPOSITORY is required}"
: "${PUBLIC_RELEASE_READ_TOKEN:?PUBLIC_RELEASE_READ_TOKEN is required}"

validate_source_run() {
  local tag=$1
  local run_id=$2
  [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]
  [[ "$run_id" =~ ^[0-9]+$ ]]

  local run_json
  run_json="$("$GH_BIN" api "repos/$GITHUB_REPOSITORY/actions/runs/$run_id")"
  test "$(jq -r .path <<<"$run_json")" = ".github/workflows/release.yml"
  test "$(jq -r .head_branch <<<"$run_json")" = "$tag"
  test "$(jq -r .status <<<"$run_json")" = "completed"
  test "$(jq -r .conclusion <<<"$run_json")" = "success"
  jq -r .head_sha <<<"$run_json"
}

preview_exists() {
  local tag=$1
  local preview_json
  preview_json="$(GH_TOKEN="$PUBLIC_RELEASE_READ_TOKEN" "$GH_BIN" api \
    "repos/$PUBLIC_RELEASE_REPOSITORY/releases/tags/${tag}-preview.1" 2>/dev/null)" \
    || return 1
  test "$(jq -r .draft <<<"$preview_json")" = "false"
  test "$(jq -r .prerelease <<<"$preview_json")" = "true"
}

stable_release_exists() {
  GH_TOKEN="$PUBLIC_RELEASE_READ_TOKEN" "$GH_BIN" api \
    "repos/$PUBLIC_RELEASE_REPOSITORY/releases/tags/$1" >/dev/null 2>&1
}

latest_stable_tag() {
  local release_json
  release_json="$(GH_TOKEN="$PUBLIC_RELEASE_READ_TOKEN" "$GH_BIN" api \
    "repos/$PUBLIC_RELEASE_REPOSITORY/releases/latest" 2>/dev/null)" \
    || return 1
  jq -r '.tag_name // empty' <<<"$release_json"
}

version_is_newer() {
  local candidate=$1
  local baseline=$2
  [[ "$candidate" =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]
  local candidate_major=${BASH_REMATCH[1]}
  local candidate_minor=${BASH_REMATCH[2]}
  local candidate_patch=${BASH_REMATCH[3]}
  [[ "$baseline" =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]
  local baseline_major=${BASH_REMATCH[1]}
  local baseline_minor=${BASH_REMATCH[2]}
  local baseline_patch=${BASH_REMATCH[3]}

  ((10#$candidate_major > 10#$baseline_major)) && return 0
  ((10#$candidate_major < 10#$baseline_major)) && return 1
  ((10#$candidate_minor > 10#$baseline_minor)) && return 0
  ((10#$candidate_minor < 10#$baseline_minor)) && return 1
  ((10#$candidate_patch > 10#$baseline_patch))
}

finalize_already_started() {
  local tag=$1
  local runs_json
  if ! runs_json="$("$GH_BIN" run list \
    --repo "$GITHUB_REPOSITORY" \
    --workflow finalize-release.yml \
    --limit 50 \
    --json displayTitle,status,conclusion)"; then
    echo "Unable to query Finalize workflow runs for $tag." >&2
    return 2
  fi
  if jq -e --arg title "Finalize $tag" '
        any(.[]; .displayTitle == $title and (
          .status != "completed" or .conclusion == "success"
        ))
      ' >/dev/null <<<"$runs_json"; then
    return 0
  else
    local jq_status=$?
    if [[ "$jq_status" -eq 1 ]]; then
      return 1
    fi
    echo "Unable to parse Finalize workflow runs for $tag." >&2
    return 2
  fi
}

selected_tag=""
selected_run_id=""
selected_commit=""

if [[ "$GITHUB_EVENT_NAME" == "workflow_dispatch" ]]; then
  selected_tag="$REQUESTED_TAG"
  selected_run_id="$REQUESTED_RUN_ID"
  selected_commit="$(validate_source_run "$selected_tag" "$selected_run_id")"
  if stable_release_exists "$selected_tag"; then
    echo "Stable release $selected_tag already exists; reconciliation is complete."
    echo "pending=false" >> "$GITHUB_OUTPUT"
    exit 0
  fi
  preview_exists "$selected_tag"
else
  current_stable_tag="$(latest_stable_tag || true)"
  if [[ -n "$current_stable_tag" && ! "$current_stable_tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Public latest release returned an invalid tag: $current_stable_tag" >&2
    exit 2
  fi
  runs_json="$("$GH_BIN" run list \
    --repo "$GITHUB_REPOSITORY" \
    --workflow release.yml \
    --status success \
    --limit 30 \
    --json databaseId,headBranch,headSha,createdAt)"
  while IFS=$'\t' read -r tag run_id commit; do
    [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || continue
    if [[ -n "$current_stable_tag" ]] && ! version_is_newer "$tag" "$current_stable_tag"; then
      continue
    fi
    stable_release_exists "$tag" && continue
    preview_exists "$tag" || continue
    if finalize_already_started "$tag"; then
      continue
    else
      finalize_status=$?
      if [[ "$finalize_status" -ne 1 ]]; then
        exit "$finalize_status"
      fi
    fi
    selected_tag="$tag"
    selected_run_id="$run_id"
    selected_commit="$(validate_source_run "$tag" "$run_id")"
    test "$selected_commit" = "$commit"
    break
  done < <(jq -r '.[] | [.headBranch, .databaseId, .headSha] | @tsv' <<<"$runs_json")
fi

if [[ -z "$selected_tag" ]]; then
  echo "No successful release is waiting for Apple notarization finalization."
  echo "pending=false" >> "$GITHUB_OUTPUT"
  exit 0
fi

{
  echo "pending=true"
  echo "tag=$selected_tag"
  echo "run_id=$selected_run_id"
  echo "commit=$selected_commit"
} >> "$GITHUB_OUTPUT"
echo "Will recheck $selected_tag from Release run $selected_run_id."
