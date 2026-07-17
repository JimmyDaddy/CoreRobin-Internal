import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { flattenReleaseArtifacts } from "./flatten-release-artifacts.mjs";

describe("public release asset assembly", () => {
  it("moves uniquely named workflow artifacts to the public release root", async () => {
    const root = await mkdtemp(join(tmpdir(), "corerobin-release-assets-"));
    await fixture(root, "macos-arm64-dmg", "CoreRobin_1.2.3_aarch64.dmg", "arm");
    await fixture(root, "windows-x64-nsis", "CoreRobin_1.2.3_x64-setup.exe", "win");

    await expect(flattenReleaseArtifacts(root)).resolves.toEqual({ files: 2, moved: 2 });
    await expect(readFile(join(root, "CoreRobin_1.2.3_aarch64.dmg"), "utf8")).resolves.toBe("arm");
    await expect(readFile(join(root, "CoreRobin_1.2.3_x64-setup.exe"), "utf8")).resolves.toBe("win");
  });

  it("fails before moving anything when two workflow artifacts share a public name", async () => {
    const root = await mkdtemp(join(tmpdir(), "corerobin-release-assets-"));
    await fixture(root, "first", "duplicate.sig", "one");
    await fixture(root, "second", "duplicate.sig", "two");

    await expect(flattenReleaseArtifacts(root)).rejects.toThrow("must have unique public names");
    await expect(readFile(join(root, "first", "duplicate.sig"), "utf8")).resolves.toBe("one");
  });
});

async function fixture(root, directory, name, content) {
  const target = join(root, directory);
  await mkdir(target, { recursive: true });
  await writeFile(join(target, name), content);
}
