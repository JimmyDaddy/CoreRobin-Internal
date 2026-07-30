import { describe, expect, it } from "vitest";

import { localizeUpdateReleaseNotes } from "./updateReleaseNotes";

const note = {
  schemaVersion: 1,
  tagName: "v1.2.3",
  title: { "zh-CN": "更清楚的版本", en: "A clearer release" },
  items: [{
    "zh-CN": "修复扫描。",
    en: "Fixed scanning.",
  }],
};
const body = `CoreRobin v1.2.3
<!-- corerobin-release-note:${encodeURIComponent(JSON.stringify(note))} -->
other markdown`;

describe("localized updater release notes", () => {
  it("uses the active locale when it exists", () => {
    expect(localizeUpdateReleaseNotes(body, "zh-CN")).toBe(
      "更清楚的版本\n\n• 修复扫描。",
    );
  });

  it("falls back to English when the locale is missing", () => {
    expect(localizeUpdateReleaseNotes(body, "ja")).toBe(
      "A clearer release\n\n• Fixed scanning.",
    );
  });

  it("keeps legacy plain-text notes readable", () => {
    expect(localizeUpdateReleaseNotes(" Existing notes. ", "en"))
      .toBe("Existing notes.");
  });
});
