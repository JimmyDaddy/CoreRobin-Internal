/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it } from "vitest";

import {
  CLEANUP_RECENT_TARGETS_STORAGE_KEY,
  loadRecentCleanupTargets,
  saveRecentCleanupTarget,
} from "./cleanupScanTargets";

describe("cleanup scan targets", () => {
  beforeEach(() => window.localStorage.clear());

  it("keeps unique recent folders while excluding the default system disk", () => {
    saveRecentCleanupTarget({ targetKind: "folder", targetPath: "/Users/test/Documents" });
    saveRecentCleanupTarget({ targetKind: "volume", targetPath: "/Volumes/Archive" });
    saveRecentCleanupTarget({ targetKind: "folder", targetPath: "/Users/test/Documents" });
    saveRecentCleanupTarget({ targetKind: "system_disk", targetPath: null });

    expect(loadRecentCleanupTargets()).toEqual([
      { targetKind: "folder", targetPath: "/Users/test/Documents" },
      { targetKind: "volume", targetPath: "/Volumes/Archive" },
    ]);
  });

  it("ignores malformed persisted targets", () => {
    window.localStorage.setItem(
      CLEANUP_RECENT_TARGETS_STORAGE_KEY,
      JSON.stringify([
        { targetKind: "folder", targetPath: "" },
        { targetKind: "system_disk", targetPath: "/" },
        { targetKind: "volume", targetPath: "/Volumes/Valid" },
      ]),
    );

    expect(loadRecentCleanupTargets()).toEqual([
      { targetKind: "volume", targetPath: "/Volumes/Valid" },
    ]);
  });
});
