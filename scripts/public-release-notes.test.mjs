import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  buildPublicReleaseManifest,
  readPublicReleaseNote,
  validatePublicReleaseNote,
} from "./public-release-notes.mjs";

const tag = "v1.2.3";
const release = {
  tag_name: tag,
  name: `CoreRobin ${tag}`,
  created_at: "2026-07-24T00:00:00Z",
  published_at: "2026-07-24T01:00:00Z",
  html_url: `https://github.com/JimmyDaddy/corerobin-monitor/releases/tag/${tag}`,
  assets: [
    "CoreRobin_1.2.3_aarch64.dmg",
    "CoreRobin_1.2.3_x64.dmg",
    "CoreRobin_1.2.3_x64-setup.exe",
    "CoreRobin_1.2.3_x64_en-US.msi",
    "CoreRobin_1.2.3_amd64.AppImage",
    "CoreRobin_1.2.3_amd64.deb",
    "SHA256SUMS",
    "SHA256SUMS.sigstore.json",
    "corerobin.spdx.json",
  ].map((name, index) => ({
    name,
    size: index + 1,
    digest: `sha256:${"a".repeat(64)}`,
    browser_download_url: `https://github.com/JimmyDaddy/corerobin-monitor/releases/download/${tag}/${name}`,
  })),
};
const note = {
  schemaVersion: 1,
  tagName: tag,
  title: { "zh-CN": "更快的版本", en: "A faster release" },
  items: [{ "zh-CN": "修复一个问题。", en: "Fixed one issue." }],
};

describe("public website release notes", () => {
  it("requires bilingual notes that match the release tag", () => {
    expect(validatePublicReleaseNote(note, tag)).toEqual(note);
    expect(() => validatePublicReleaseNote({ ...note, tagName: "v1.2.4" }, tag)).toThrow(/does not match/);
    expect(() => validatePublicReleaseNote({ ...note, title: { "zh-CN": "只有中文" } }, tag)).toThrow(/requires en/);
  });

  it("builds one atomic manifest and keeps previous history", () => {
    const manifest = buildPublicReleaseManifest(release, {
      schemaVersion: 2,
      releaseHistory: [
        { tagName: "v1.2.2", publishedAt: "2026-07-20T00:00:00Z", title: note.title, items: note.items },
      ],
    }, note);
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.releaseHistory.map((entry) => entry.tagName)).toEqual([tag, "v1.2.2"]);
    expect(manifest.releaseHistory[0].publishedAt).toBe(release.published_at);
  });

  it("keeps the checked-in release note aligned with the current version", () => {
    const version = JSON.parse(readFileSync("package.json", "utf8")).version;
    expect(readPublicReleaseNote(`v${version}`).tagName).toBe(`v${version}`);
  });
});
