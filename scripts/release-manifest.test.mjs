import { describe, expect, it } from "vitest";

import { buildReleaseManifest } from "./release-manifest.mjs";

const tag = "v1.2.3";
const release = {
  tag_name: tag,
  name: "CoreRobin v1.2.3",
  published_at: "2026-07-17T00:00:00Z",
  html_url: "https://github.com/JimmyDaddy/corerobin-monitor/releases/tag/v1.2.3",
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

describe("public release manifest", () => {
  it("maps all supported installers in a stable UI order", () => {
    const manifest = buildReleaseManifest(release);
    expect(manifest.tagName).toBe(tag);
    expect(manifest.installers.map((asset) => asset.id)).toEqual([
      "macos-arm64-dmg", "macos-x64-dmg", "windows-x64-exe",
      "windows-x64-msi", "linux-x64-appimage", "linux-x64-deb",
    ]);
    expect(manifest.evidence.map((asset) => asset.name).sort()).toEqual([
      "SHA256SUMS", "SHA256SUMS.sigstore.json", "corerobin.spdx.json",
    ]);
  });

  it("refuses a release without all three verification artifacts", () => {
    const incomplete = { ...release, assets: release.assets.filter((asset) => asset.name !== "corerobin.spdx.json") };
    expect(() => buildReleaseManifest(incomplete)).toThrow("missing verification evidence");
  });
});
