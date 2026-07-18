import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createLocalMacOSManifest,
  localMacOSAssetNames,
  verifyLocalMacOSManifest,
} from "./local-macos-release-manifest.mjs";

const TAG = "v1.2.3";
const COMMIT = "a".repeat(40);

describe("local macOS release handoff", () => {
  it("binds the exact local assets to the release tag, commit, and Apple team", async () => {
    const root = await fixtureRoot();
    await createLocalMacOSManifest({
      tag: TAG,
      commit: COMMIT,
      teamId: "AB12CD34EF",
      assetsRoot: root,
    });

    await expect(verifyLocalMacOSManifest({ tag: TAG, commit: COMMIT, assetsRoot: root }))
      .resolves.toMatchObject({
        tag: TAG,
        commit: COMMIT,
        bundleIdentifier: "com.corerobin.monitor",
        teamId: "AB12CD34EF",
      });
  });

  it("fails closed when an uploaded macOS asset changes after verification", async () => {
    const root = await fixtureRoot();
    await createLocalMacOSManifest({
      tag: TAG,
      commit: COMMIT,
      teamId: "AB12CD34EF",
      assetsRoot: root,
    });
    await writeFile(join(root, localMacOSAssetNames(TAG)[0]), "tampered");

    await expect(verifyLocalMacOSManifest({ tag: TAG, commit: COMMIT, assetsRoot: root }))
      .rejects.toThrow("checksum mismatch");
  });

  it("rejects a manifest created from another release commit", async () => {
    const root = await fixtureRoot();
    await createLocalMacOSManifest({
      tag: TAG,
      commit: COMMIT,
      teamId: "AB12CD34EF",
      assetsRoot: root,
    });

    await expect(verifyLocalMacOSManifest({ tag: TAG, commit: "b".repeat(40), assetsRoot: root }))
      .rejects.toThrow("does not match the requested release source");
  });
});

async function fixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "corerobin-local-macos-"));
  for (const name of localMacOSAssetNames(TAG)) {
    await writeFile(join(root, name), `fixture:${name}`);
  }
  return root;
}
