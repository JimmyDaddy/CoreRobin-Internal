import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { verifyReleaseSmokeEvidence } from "./verify-release-smoke-evidence.mjs";

let temporaryDirectory;
afterEach(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = undefined;
});

describe("release smoke evidence promotion gate", () => {
  it("accepts four matching real-device records and rejects an unverified check", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "corerobin-smoke-"));
    const artifacts = {
      macosArm64: "CoreRobin_1.2.3_aarch64.dmg",
      macosX64: "CoreRobin_1.2.3_x64.dmg",
      windowsX64: "CoreRobin_1.2.3_x64-setup.exe",
      linuxX64: "CoreRobin_1.2.3_amd64.AppImage",
    };
    const evidenceByRole = {};
    const checksumLines = [];
    for (const [role, name] of Object.entries(artifacts)) {
      const content = Buffer.from(`fixture:${role}`);
      const digest = createHash("sha256").update(content).digest("hex");
      await writeFile(join(temporaryDirectory, name), content);
      checksumLines.push(`${digest}  nested/${name}`);
      const platform = role.startsWith("macos") ? "darwin" : role.startsWith("windows") ? "win32" : "linux";
      evidenceByRole[role] = evidence({
        artifact: name,
        sha256: digest,
        platform,
        architecture: role === "macosArm64" ? "arm64" : "x64",
      });
    }
    await writeFile(join(temporaryDirectory, "SHA256SUMS"), `${checksumLines.join("\n")}\n`);

    await expect(verifyReleaseSmokeEvidence({
      tag: "v1.2.3",
      commit: "a".repeat(40),
      assetsDirectory: temporaryDirectory,
      evidenceByRole,
    })).resolves.toMatchObject({ macosArm64: { artifact: artifacts.macosArm64 } });

    evidenceByRole.windowsX64.checks.find(({ id }) => id === "tray").status = "not-verified";
    await expect(verifyReleaseSmokeEvidence({
      tag: "v1.2.3",
      commit: "a".repeat(40),
      assetsDirectory: temporaryDirectory,
      evidenceByRole,
    })).rejects.toThrow("windowsX64: tray was not passed");
  });
});

function evidence({ artifact, sha256, platform, architecture }) {
  const checks = [
    "launch", "main", "tray", "companion", "health-sync", "appearance-sync", "background", "quit-relaunch",
  ].map((id) => ({ id, status: "passed", note: "" }));
  checks.push(...["cleanup-limited", "cleanup-authorized"].map((id) => ({
    id,
    status: platform === "darwin" ? "passed" : "not-applicable",
    note: "",
  })));
  return {
    schemaVersion: 1,
    product: "CoreRobin",
    bundleIdentifier: "com.corerobin.monitor",
    capturedAt: "2026-07-17T00:00:00.000Z",
    tag: "v1.2.3",
    commit: "a".repeat(40),
    platform,
    platformRelease: "fixture",
    platformVersion: "fixture",
    architecture,
    artifact: { name: artifact, sha256 },
    applicationPath: "/fixture/CoreRobin",
    result: "passed",
    checks,
  };
}
