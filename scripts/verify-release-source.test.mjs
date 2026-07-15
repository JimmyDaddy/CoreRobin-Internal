import { describe, expect, it } from "vitest";

import {
  assertMatchingVersions,
  commitBelongsToTrustedRef,
  versionFromReleaseTag,
} from "./verify-release-source.mjs";

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

  it("rejects a tag commit that is not on the trusted branch", () => {
    const git = (arguments_) => {
      if (arguments_[0] === "merge-base" && arguments_.at(-1) === "origin/main") return "";
      throw new Error("not an ancestor");
    };
    expect(commitBelongsToTrustedRef("untrusted", "origin/main", git)).toBe(true);
    expect(commitBelongsToTrustedRef("untrusted", "origin/release", git)).toBe(false);
  });
});
