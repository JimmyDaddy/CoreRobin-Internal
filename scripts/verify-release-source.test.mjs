import { describe, expect, it } from "vitest";

import {
  assertMatchingVersions,
  assertReleaseChangelog,
  commitBelongsToTrustedRef,
  readProjectVersions,
  verifyReleaseReadiness,
  versionFromReleaseTag,
} from "./verify-release-source.mjs";
import { prepareReleaseFiles } from "./prepare-release.mjs";

describe("release source verification", () => {
  it("accepts only exact stable semantic version tags", () => {
    expect(versionFromReleaseTag("v1.2.3")).toBe("1.2.3");
    for (const tag of ["1.2.3", "v1.2", "v1.2.3-beta.1", "v01.2.3.4", "vnext.1.1"]) {
      expect(() => versionFromReleaseTag(tag)).toThrow(/vMAJOR\.MINOR\.PATCH/);
    }
  });

  it("rejects a version mismatch in any package manifest", () => {
    expect(() =>
      assertMatchingVersions("1.2.3", {
        "package.json": "1.2.3",
        "src-tauri/tauri.conf.json": "1.2.4",
        "src-tauri/Cargo.toml": "1.2.3",
      }),
    ).toThrow(/tauri\.conf\.json=1\.2\.4/);
  });

  it("requires a non-empty changelog section for the release", () => {
    expect(() => assertReleaseChangelog("1.2.3", "# Log\n\n## 未发布\n"))
      .toThrow(/does not contain/);
    expect(() => assertReleaseChangelog("1.2.3", "# Log\n\n## 1.2.3\n\n## 1.2.2\nOld\n"))
      .toThrow(/is empty/);
    expect(() => assertReleaseChangelog("1.2.3", "# Log\n\n## 1.2.3 — 2026-07-20\n\nReady\n"))
      .not.toThrow();
  });

  it("updates all four version sources without changing dependency versions", () => {
    const prepared = prepareReleaseFiles({
      packageJson: '{"version":"1.0.0","private":true}\n',
      tauriConfig: '{"version":"1.0.0","identifier":"example.app"}\n',
      cargoManifest: '[package]\nname = "core-robin"\nversion = "1.0.0"\n\n[dependencies]\n',
      cargoLock: '[[package]]\nname = "dependency"\nversion = "9.9.9"\n\n[[package]]\nname = "core-robin"\nversion = "1.0.0"\n',
    }, "1.2.3");

    expect(JSON.parse(prepared.packageJson).version).toBe("1.2.3");
    expect(JSON.parse(prepared.tauriConfig).version).toBe("1.2.3");
    expect(prepared.cargoManifest).toContain('version = "1.2.3"');
    expect(prepared.cargoLock).toContain('name = "dependency"\nversion = "9.9.9"');
    expect(prepared.cargoLock).toContain('name = "core-robin"\nversion = "1.2.3"');
  });

  it("passes release readiness for the checked-in project", () => {
    const expected = readProjectVersions()["package.json"];
    expect(verifyReleaseReadiness(expected).expectedVersion).toBe(expected);
  });

  it("rejects a tag commit that is not on the trusted branch", () => {
    const git = (arguments_) => {
      if (arguments_[0] === "merge-base" && arguments_.at(-1) === "origin/main") return "";
      throw new Error("not an ancestor");
    };
    expect(commitBelongsToTrustedRef("untrusted", "origin/main", git)).toBe(true);
    expect(commitBelongsToTrustedRef("untrusted", "origin/release", git)).toBe(false);
  });
});
