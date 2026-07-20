import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { generateUpdaterManifest } from "./generate-updater-manifest.mjs";

describe("signed updater manifest", () => {
  it("flattens uniquely named packages and embeds signatures for all supported targets", async () => {
    const root = await fixtureRoot();

    const manifest = await generateUpdaterManifest({
      tag: "v1.2.3",
      artifactsRoot: root,
      notes: "Safer update delivery.\n",
      pubDate: "2026-07-17T12:00:00+08:00",
    });

    expect(manifest.version).toBe("1.2.3");
    expect(manifest.pub_date).toBe("2026-07-17T04:00:00.000Z");
    expect(Object.keys(manifest.platforms)).toEqual([
      "darwin-aarch64",
      "darwin-x86_64",
      "linux-x86_64",
      "windows-x86_64",
    ]);
    expect(manifest.platforms["darwin-aarch64"]).toEqual({
      signature: "signature-darwin-aarch64",
      url: "https://github.com/JimmyDaddy/corerobin-monitor/releases/download/v1.2.3/CoreRobin_1.2.3_aarch64.app.tar.gz",
    });
    expect(manifest.platforms["linux-x86_64"]).toEqual({
      signature: "signature-linux-x86_64",
      url: "https://github.com/JimmyDaddy/corerobin-monitor/releases/download/v1.2.3/CoreRobin_1.2.3_amd64.AppImage",
    });
    expect(manifest.platforms["windows-x86_64"]).toEqual({
      signature: "signature-windows-x86_64",
      url: "https://github.com/JimmyDaddy/corerobin-monitor/releases/download/v1.2.3/CoreRobin_1.2.3_x64-setup.exe",
    });
    await expect(readFile(join(root, "CoreRobin_1.2.3_x64-setup.exe"), "utf8"))
      .resolves.toBe("package-windows-x86_64");
    await expect(readFile(join(root, "latest.json"), "utf8"))
      .resolves.toContain('"linux-x86_64"');
  });

  it("fails closed when a package signature is missing", async () => {
    const root = await fixtureRoot({ omitSignatureFor: "linux-x86_64" });

    await expect(generateUpdaterManifest({
      tag: "v1.2.3",
      artifactsRoot: root,
      notes: "Notes",
      pubDate: "2026-07-17T00:00:00Z",
    })).rejects.toThrow("linux-x86_64 updater signature");
    await expect(readFile(
      join(root, "corerobin-macos-aarch64-updater", "CoreRobin.app.tar.gz"),
      "utf8",
    )).resolves.toBe("package-darwin-aarch64");
  });
});

async function fixtureRoot({ omitSignatureFor } = {}) {
  const root = await mkdtemp(join(tmpdir(), "corerobin-updater-"));
  const fixtures = [
    ["darwin-aarch64", "corerobin-macos-aarch64-updater", "CoreRobin.app.tar.gz"],
    ["darwin-x86_64", "corerobin-macos-x86_64-updater", "CoreRobin.app.tar.gz"],
    ["linux-x86_64", "corerobin-linux-x86_64-appimage-.AppImage", "CoreRobin_1.2.3_amd64.AppImage"],
    ["windows-x86_64", "corerobin-windows-x86_64-nsis-.exe", "CoreRobin_1.2.3_x64-setup.exe"],
  ];
  for (const [platform, directory, name] of fixtures) {
    const target = join(root, directory);
    await mkdir(target, { recursive: true });
    await writeFile(join(target, name), `package-${platform}`);
    if (omitSignatureFor !== platform) {
      const signatures = join(root, `${directory}-signature`);
      await mkdir(signatures, { recursive: true });
      await writeFile(join(signatures, `${name}.sig`), `signature-${platform}\n`);
    }
  }
  return root;
}
