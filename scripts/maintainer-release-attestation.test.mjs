import { describe, expect, it } from "vitest";

import { createMaintainerReleaseAttestation } from "./create-maintainer-release-attestation.mjs";

const validInput = {
  tag: "v1.2.3",
  commit: "a".repeat(40),
  testedPlatforms: "macos-arm64",
  statement: "I ACCEPT UNVERIFIED PLATFORM RISK FOR v1.2.3: macos-x64,windows-x64,linux-x64",
  note: "The maintainer completed the Apple Silicon acceptance pass.",
  actor: "release-maintainer",
  runId: "123456789",
  capturedAt: "2026-07-21T00:00:00.000Z",
};

describe("maintainer release attestation", () => {
  it("records tested and explicitly accepted unverified platforms", () => {
    expect(createMaintainerReleaseAttestation(validInput)).toEqual({
      schemaVersion: 1,
      authorization: "maintainer-attestation",
      product: "CoreRobin",
      tag: "v1.2.3",
      commit: "a".repeat(40),
      actor: "release-maintainer",
      workflowRunId: "123456789",
      capturedAt: "2026-07-21T00:00:00.000Z",
      testedPlatforms: ["macos-arm64"],
      unverifiedPlatforms: ["macos-x64", "windows-x64", "linux-x64"],
      statement: validInput.statement,
      note: validInput.note,
    });
  });

  it("rejects a statement that does not exactly enumerate the accepted risk", () => {
    expect(() => createMaintainerReleaseAttestation({
      ...validInput,
      statement: "I accept the risk",
    })).toThrow("Maintainer attestation must exactly equal");
  });

  it("rejects unknown, duplicate, empty, or fully tested platform sets", () => {
    for (const testedPlatforms of [
      "",
      "macos-arm64,macos-arm64",
      "macos-arm64,freebsd-x64",
      "macos-arm64,macos-x64,windows-x64,linux-x64",
    ]) {
      expect(() => createMaintainerReleaseAttestation({
        ...validInput,
        testedPlatforms,
      })).toThrow();
    }
  });

  it("requires an auditable human-readable reason", () => {
    expect(() => createMaintainerReleaseAttestation({
      ...validInput,
      note: "too short",
    })).toThrow("at least 20 characters");
  });
});
