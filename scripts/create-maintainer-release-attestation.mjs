import process from "node:process";
import { pathToFileURL } from "node:url";

const supportedPlatforms = ["macos-arm64", "macos-x64", "windows-x64", "linux-x64"];

export function createMaintainerReleaseAttestation({
  tag,
  commit,
  testedPlatforms,
  statement,
  note,
  actor,
  runId,
  capturedAt = new Date().toISOString(),
}) {
  assert(/^v\d+\.\d+\.\d+$/.test(tag ?? ""), `Invalid release tag: ${tag ?? ""}`);
  assert(/^[0-9a-f]{40}$/.test(commit ?? ""), `Invalid release commit: ${commit ?? ""}`);
  assert(typeof actor === "string" && actor.trim().length > 0, "GitHub actor is required.");
  assert(/^\d+$/.test(runId ?? ""), "GitHub run ID is required.");
  assert(!Number.isNaN(Date.parse(capturedAt)), "Attestation timestamp is invalid.");

  const tested = parseTestedPlatforms(testedPlatforms);
  assert(tested.length > 0, "At least one tested platform must be recorded.");
  assert(tested.length < supportedPlatforms.length, "Use device-evidence mode when all platforms were tested.");
  const unverified = supportedPlatforms.filter((platform) => !tested.includes(platform));
  const expectedStatement = `I ACCEPT UNVERIFIED PLATFORM RISK FOR ${tag}: ${unverified.join(",")}`;
  assert(statement === expectedStatement, `Maintainer attestation must exactly equal: ${expectedStatement}`);

  const normalizedNote = typeof note === "string" ? note.trim() : "";
  assert(normalizedNote.length >= 20, "Maintainer note must contain at least 20 characters.");

  return {
    schemaVersion: 1,
    authorization: "maintainer-attestation",
    product: "CoreRobin",
    tag,
    commit,
    actor: actor.trim(),
    workflowRunId: runId,
    capturedAt,
    testedPlatforms: tested,
    unverifiedPlatforms: unverified,
    statement,
    note: normalizedNote,
  };
}

function parseTestedPlatforms(value) {
  const platforms = typeof value === "string"
    ? value.split(",").map((platform) => platform.trim()).filter(Boolean)
    : [];
  assert(new Set(platforms).size === platforms.length, "Tested platform IDs must be unique.");
  for (const platform of platforms) {
    assert(supportedPlatforms.includes(platform), `Unsupported tested platform: ${platform}`);
  }
  return supportedPlatforms.filter((platform) => platforms.includes(platform));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const record = createMaintainerReleaseAttestation({
      tag: process.env.RELEASE_TAG,
      commit: process.env.RELEASE_COMMIT,
      testedPlatforms: process.env.MAINTAINER_TESTED_PLATFORMS,
      statement: process.env.MAINTAINER_ATTESTATION,
      note: process.env.MAINTAINER_NOTE,
      actor: process.env.GITHUB_ACTOR,
      runId: process.env.GITHUB_RUN_ID,
    });
    console.log(JSON.stringify(record, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
