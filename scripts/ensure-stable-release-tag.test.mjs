import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const scriptPath = resolve("scripts/ensure-stable-release-tag.sh");
const temporaryDirectories = [];
const releaseCommit = "a".repeat(40);
const SCRIPT_TEST_TIMEOUT_MS = 15_000;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("stable release tag activation", () => {
  it("creates a missing stable tag", () => {
    const result = runActivator();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Created stable tag v0.1.9 at ${releaseCommit}.`);
    expect(result.calls).toContain(
      "api repos/JimmyDaddy/CoreRobin-Internal/git/matching-refs/tags/v0.1.9",
    );
    expect(result.calls).toContain(
      `api --method POST repos/JimmyDaddy/CoreRobin-Internal/git/refs -f ref=refs/tags/v0.1.9 -f sha=${releaseCommit}`,
    );
  }, SCRIPT_TEST_TIMEOUT_MS);

  it("accepts an existing tag that points to the verified commit", () => {
    const result = runActivator({ existingSha: releaseCommit });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "Stable tag v0.1.9 already points to the verified candidate commit.",
    );
    expect(result.calls).not.toContain("--method POST");
  }, SCRIPT_TEST_TIMEOUT_MS);

  it("rejects an existing tag that points to another commit", () => {
    const otherCommit = "b".repeat(40);
    const result = runActivator({ existingSha: otherCommit });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `Stable tag v0.1.9 points to ${otherCommit}, expected ${releaseCommit}.`,
    );
    expect(result.calls).not.toContain("--method POST");
  }, SCRIPT_TEST_TIMEOUT_MS);

  it("does not create a tag when the lookup itself fails", () => {
    const result = runActivator({ lookupStatus: 22 });

    expect(result.status).toBe(22);
    expect(result.stderr).toContain("simulated tag lookup failure");
    expect(result.calls).not.toContain("--method POST");
  }, SCRIPT_TEST_TIMEOUT_MS);
});

function runActivator({ existingSha = "", lookupStatus = 0 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "corerobin-release-tag-"));
  temporaryDirectories.push(directory);
  const mockGhPath = join(directory, "gh");
  const callLogPath = join(directory, "gh-calls.log");
  writeFileSync(
    mockGhPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$MOCK_GH_CALL_LOG"
if [[ "\${1:-}" == "api" && "\${2:-}" == *"/git/matching-refs/tags/"* ]]; then
  if [[ "$MOCK_LOOKUP_STATUS" != "0" ]]; then
    echo "simulated tag lookup failure" >&2
    exit "$MOCK_LOOKUP_STATUS"
  fi
  printf '%s' "$MOCK_EXISTING_SHA"
  exit 0
fi
if [[ "\${1:-}" == "api" && "\${2:-}" == "--method" && "\${3:-}" == "POST" ]]; then
  exit 0
fi
echo "unexpected gh invocation: $*" >&2
exit 64
`,
  );
  chmodSync(mockGhPath, 0o755);

  const result = spawnSync("bash", [scriptPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_REPOSITORY: "JimmyDaddy/CoreRobin-Internal",
      MOCK_EXISTING_SHA: existingSha,
      MOCK_GH_CALL_LOG: callLogPath,
      MOCK_LOOKUP_STATUS: String(lookupStatus),
      PATH: `${directory}:${process.env.PATH ?? ""}`,
      RELEASE_COMMIT: releaseCommit,
      RELEASE_VERSION: "0.1.9",
    },
  });

  return {
    ...result,
    calls: readFileSync(callLogPath, "utf8"),
  };
}
