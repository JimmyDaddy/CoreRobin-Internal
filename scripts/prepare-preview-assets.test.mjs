import { mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { preparePreviewAssets } from "./prepare-preview-assets.mjs";

describe("public Preview assets", () => {
  it("includes installers but excludes updater feeds and marks raw macOS DMGs", async () => {
    const root = await mkdtemp(join(tmpdir(), "corerobin-preview-source-"));
    const output = await mkdtemp(join(tmpdir(), "corerobin-preview-output-"));
    const fixtures = [
      ["corerobin-macos-aarch64", "CoreRobin_1.2.3_aarch64.dmg"],
      ["corerobin-macos-aarch64", "CoreRobin.app.tar.gz"],
      ["corerobin-macos-x86_64", "CoreRobin_1.2.3_x64.dmg"],
      ["corerobin-linux-x86_64-appimage", "CoreRobin_1.2.3_amd64.AppImage"],
      ["corerobin-linux-x86_64-appimage", "CoreRobin.AppImage.tar.gz"],
      ["corerobin-windows-x86_64-nsis", "CoreRobin_1.2.3_x64-setup.exe"],
      ["metadata", "latest.json"],
    ];
    for (const [directory, name] of fixtures) {
      await mkdir(join(root, directory), { recursive: true });
      await writeFile(join(root, directory, name), `${directory}:${name}`);
    }

    const result = await preparePreviewAssets({ tag: "v1.2.3", artifactsRoot: root, outputRoot: output });
    const names = (await readdir(output)).sort();

    expect(result.platformCounts).toEqual({ macos: 2, linux: 1, windows: 1 });
    expect(names).toContain("CoreRobin_1.2.3_aarch64_unnotarized-preview.dmg");
    expect(names).toContain("CoreRobin_1.2.3_x64_unnotarized-preview.dmg");
    expect(names).toContain("PREVIEW-SHA256SUMS");
    expect(names).not.toContain("latest.json");
    expect(names.some((name) => name.endsWith(".tar.gz"))).toBe(false);
  });
});
