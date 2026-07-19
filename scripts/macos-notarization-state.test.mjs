import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createMacOSNotarizationState,
  macOSNotarizationStateName,
  verifyMacOSNotarizationState,
} from "./macos-notarization-state.mjs";

const TAG = "v1.2.3";
const COMMIT = "a".repeat(40);
const RUN_ID = "123456789";
const TEAM_ID = "AB12CD34EF";
const SUBMISSION_ID = "33c1b193-a8d8-4c64-937a-dacd2992d49b";

describe("asynchronous macOS notarization state", () => {
  it("binds the submission to the source run and exact pre-staple assets", async () => {
    const root = await fixtureRoot();
    const statePath = join(root, macOSNotarizationStateName(TAG, "aarch64"));
    await createMacOSNotarizationState({
      tag: TAG,
      commit: COMMIT,
      sourceRunId: RUN_ID,
      target: "aarch64-apple-darwin",
      publicArch: "aarch64",
      expectedArch: "arm64",
      teamId: TEAM_ID,
      submissionId: SUBMISSION_ID,
      assetsRoot: root,
      outputPath: statePath,
    });

    await expect(verifyMacOSNotarizationState({
      statePath,
      tag: TAG,
      commit: COMMIT,
      sourceRunId: RUN_ID,
      publicArch: "aarch64",
      teamId: TEAM_ID,
      assetsRoot: root,
    })).resolves.toMatchObject({
      sourceRunId: RUN_ID,
      submissionId: SUBMISSION_ID,
      publicArch: "aarch64",
    });
  });

  it("fails closed when a raw asset changes before finalization", async () => {
    const root = await fixtureRoot();
    const statePath = join(root, macOSNotarizationStateName(TAG, "aarch64"));
    await createMacOSNotarizationState({
      tag: TAG,
      commit: COMMIT,
      sourceRunId: RUN_ID,
      target: "aarch64-apple-darwin",
      publicArch: "aarch64",
      expectedArch: "arm64",
      teamId: TEAM_ID,
      submissionId: SUBMISSION_ID,
      assetsRoot: root,
      outputPath: statePath,
    });
    await writeFile(join(root, "dmg", "CoreRobin_1.2.3_aarch64.dmg"), "tampered");

    await expect(verifyMacOSNotarizationState({
      statePath,
      tag: TAG,
      commit: COMMIT,
      sourceRunId: RUN_ID,
      publicArch: "aarch64",
      teamId: TEAM_ID,
      assetsRoot: root,
    })).rejects.toThrow("checksum mismatch");
  });

  it("rejects a callback that points at another Actions run", async () => {
    const root = await fixtureRoot();
    const statePath = join(root, macOSNotarizationStateName(TAG, "aarch64"));
    await createMacOSNotarizationState({
      tag: TAG,
      commit: COMMIT,
      sourceRunId: RUN_ID,
      target: "aarch64-apple-darwin",
      publicArch: "aarch64",
      expectedArch: "arm64",
      teamId: TEAM_ID,
      submissionId: SUBMISSION_ID,
      assetsRoot: root,
      outputPath: statePath,
    });

    await expect(verifyMacOSNotarizationState({
      statePath,
      tag: TAG,
      commit: COMMIT,
      sourceRunId: "987654321",
      publicArch: "aarch64",
      teamId: TEAM_ID,
      assetsRoot: root,
    })).rejects.toThrow("does not match the requested release source");
  });
});

async function fixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "corerobin-notary-state-"));
  await mkdir(join(root, "dmg"));
  await mkdir(join(root, "macos"));
  await writeFile(join(root, "dmg", "CoreRobin_1.2.3_aarch64.dmg"), "dmg");
  await writeFile(join(root, "macos", "CoreRobin.app.tar.gz"), "updater");
  await writeFile(join(root, "macos", "CoreRobin.app.tar.gz.sig"), "signature");
  return root;
}
