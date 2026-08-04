import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const scriptPath = resolve("scripts/discover-pending-notarization.sh");
const temporaryDirectories = [];
const releaseCommit = "a".repeat(40);

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("pending notarization discovery", () => {
  it("treats a schedule with no pending release as a successful no-op", () => {
    const result = runScenario("stable-release");

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.output).toEqual({ pending: "false" });
    expect(result.stdout).toContain(
      "No successful release is waiting for Apple notarization finalization.",
    );
    expectRunListCallsHaveExplicitRepository(result.calls);
  });

  it("selects a trusted release whose Preview still needs finalization", () => {
    const result = runScenario("pending-release");

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.output).toEqual({
      pending: "true",
      tag: "v0.1.25",
      run_id: "425",
      commit: releaseCommit,
    });
    expect(result.stdout).toContain("Will recheck v0.1.25 from Release run 425.");
    expectRunListCallsHaveExplicitRepository(result.calls);
  });

  it("does not duplicate a finalization that is already active", () => {
    const result = runScenario("finalize-active");

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.output).toEqual({ pending: "false" });
    expectRunListCallsHaveExplicitRepository(result.calls);
  });

  it("ignores orphaned Previews older than the current stable release", () => {
    const result = runScenario("old-preview");

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.output).toEqual({ pending: "false" });
    expect(result.calls).not.toContain(
      "api repos/JimmyDaddy/corerobin-monitor/releases/tags/v0.1.8-preview.1",
    );
    expectRunListCallsHaveExplicitRepository(result.calls);
  });
});

function runScenario(scenario) {
  const directory = mkdtempSync(join(tmpdir(), "corerobin-notary-discovery-"));
  temporaryDirectories.push(directory);
  const fakeGhPath = join(directory, "gh");
  const outputPath = join(directory, "github-output");
  const callsPath = join(directory, "gh-calls.jsonl");
  writeFileSync(fakeGhPath, fakeGhSource);
  chmodSync(fakeGhPath, 0o755);
  writeFileSync(outputPath, "");
  writeFileSync(callsPath, "");

  const result = spawnSync("bash", [scriptPath], {
    cwd: resolve("."),
    encoding: "utf8",
    env: {
      ...process.env,
      FAKE_GH_SCENARIO: scenario,
      GH_BIN: fakeGhPath,
      GH_CALLS_PATH: callsPath,
      GITHUB_EVENT_NAME: "schedule",
      GITHUB_OUTPUT: outputPath,
      GITHUB_REPOSITORY: "JimmyDaddy/CoreRobin-Internal",
      PUBLIC_RELEASE_READ_TOKEN: "test-public-read-token",
      PUBLIC_RELEASE_REPOSITORY: "JimmyDaddy/corerobin-monitor",
      REQUESTED_RUN_ID: "",
      REQUESTED_TAG: "",
    },
  });

  const output = Object.fromEntries(
    readFileSync(outputPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(/=(.*)/s).slice(0, 2)),
  );
  const calls = readFileSync(callsPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean);

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    output,
    calls,
  };
}

function expectRunListCallsHaveExplicitRepository(calls) {
  const runListCalls = calls.filter((call) => call.startsWith("run list "));
  expect(runListCalls.length).toBeGreaterThan(0);
  for (const call of runListCalls) {
    expect(call).toContain("--repo JimmyDaddy/CoreRobin-Internal");
  }
}

const fakeGhSource = `#!/usr/bin/env bash
set -euo pipefail

printf '%s\\n' "$*" >> "$GH_CALLS_PATH"

if [[ "$1" == "run" && "$2" == "list" ]]; then
  [[ "$*" == *"--repo JimmyDaddy/CoreRobin-Internal"* ]] || {
    echo "missing explicit repository" >&2
    exit 1
  }
  if [[ "$*" == *"--workflow release.yml"* ]]; then
    if [[ "$FAKE_GH_SCENARIO" == "old-preview" ]]; then
      printf '%s\\n' '[{"databaseId":408,"headBranch":"v0.1.8","headSha":"${releaseCommit}","createdAt":"2026-07-20T00:00:00Z"}]'
    else
      printf '%s\\n' '[{"databaseId":425,"headBranch":"v0.1.25","headSha":"${releaseCommit}","createdAt":"2026-08-04T00:00:00Z"}]'
    fi
    exit 0
  fi
  if [[ "$*" == *"--workflow finalize-release.yml"* ]]; then
    if [[ "$FAKE_GH_SCENARIO" == "finalize-active" ]]; then
      printf '%s\\n' '[{"displayTitle":"Finalize v0.1.25","status":"in_progress","conclusion":""}]'
    else
      printf '%s\\n' '[]'
    fi
    exit 0
  fi
fi

if [[ "$1" == "api" ]]; then
  case "$2" in
    repos/JimmyDaddy/corerobin-monitor/releases/latest)
      printf '%s\\n' '{"tag_name":"v0.1.24","draft":false,"prerelease":false}'
      exit 0
      ;;
    repos/JimmyDaddy/CoreRobin-Internal/actions/runs/425)
      printf '%s\\n' '{"path":".github/workflows/release.yml","head_branch":"v0.1.25","status":"completed","conclusion":"success","head_sha":"${releaseCommit}"}'
      exit 0
      ;;
    repos/JimmyDaddy/corerobin-monitor/releases/tags/v0.1.25)
      if [[ "$FAKE_GH_SCENARIO" == "stable-release" ]]; then
        printf '%s\\n' '{"draft":false,"prerelease":false}'
        exit 0
      fi
      exit 1
      ;;
    repos/JimmyDaddy/corerobin-monitor/releases/tags/v0.1.25-preview.1)
      printf '%s\\n' '{"draft":false,"prerelease":true}'
      exit 0
      ;;
  esac
fi

echo "unexpected gh invocation: $*" >&2
exit 1
`;
