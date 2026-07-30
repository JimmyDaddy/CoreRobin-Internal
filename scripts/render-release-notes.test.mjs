import { describe, expect, it } from "vitest";

import { renderReleaseNotes } from "./render-release-notes.mjs";

const note = {
  schemaVersion: 1,
  tagName: "v1.2.3",
  title: { "zh-CN": "更可靠的扫描", en: "More reliable scans" },
  items: [{
    "zh-CN": "扫描可以在唤醒后继续。",
    en: "Scans can continue after wake.",
  }],
};

describe("release notes renderer", () => {
  it("renders both public languages from the structured source", () => {
    const rendered = renderReleaseNotes(note);
    expect(rendered).toContain("## 更可靠的扫描");
    expect(rendered).toContain("- 扫描可以在唤醒后继续。");
    expect(rendered).toContain("## More reliable scans");
    expect(rendered).toContain("- Scans can continue after wake.");
    expect(rendered).toContain("corerobin-release-note:");
  });
});
