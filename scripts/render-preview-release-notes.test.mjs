import { describe, expect, it } from "vitest";

import { renderPreviewReleaseNotes } from "./render-preview-release-notes.mjs";

describe("Preview release notes", () => {
  it("states the unnotarized and manual-download trust boundary", () => {
    const notes = renderPreviewReleaseNotes("v1.2.3");
    expect(notes).toContain("Developer ID Application");
    expect(notes).toContain("尚未完成 Apple 公证");
    expect(notes).toContain("不包含 `latest.json`");
    expect(notes).toContain("独立的 `v1.2.3` Release");
  });
});
