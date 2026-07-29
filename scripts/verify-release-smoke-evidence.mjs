import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const roles = {
  macosArm64: {
    environment: "SMOKE_EVIDENCE_MACOS_ARM64",
    platform: "darwin",
    architecture: "arm64",
    artifact: /^CoreRobin_.+_aarch64\.dmg$/,
  },
  macosX64: {
    environment: "SMOKE_EVIDENCE_MACOS_X64",
    platform: "darwin",
    architecture: "x64",
    artifact: /^CoreRobin_.+_x64\.dmg$/,
  },
  windowsX64: {
    environment: "SMOKE_EVIDENCE_WINDOWS_X64",
    platform: "win32",
    architecture: "x64",
    artifact: /^CoreRobin_.+_x64(?:-setup\.exe|_en-US\.msi)$/,
  },
  linuxX64: {
    environment: "SMOKE_EVIDENCE_LINUX_X64",
    platform: "linux",
    architecture: "x64",
    artifact: /^CoreRobin_.+_amd64\.(?:AppImage|deb)$/,
  },
};
const commonChecks = [
  "launch",
  "main",
  "tray",
  "companion",
  "health-sync",
  "appearance-sync",
  "background",
  "updater-discovery",
  "updater-notification",
  "updater-install-restart",
  "application-uninstall-capability",
  "removable-volume-eject",
  "today-review",
  "quit-relaunch",
];
const macOSChecks = ["cleanup-limited", "cleanup-authorized"];
const macOSUninstallChecks = ["application-uninstall-review"];
const nativeUninstallChecks = [
  "native-application-uninstall-review",
  "native-application-uninstall-cancel",
  "native-application-uninstall-complete",
];

export async function verifyReleaseSmokeEvidence({ tag, commit, assetsDirectory, evidenceByRole }) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error(`Invalid release tag: ${tag}`);
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`Invalid release commit: ${commit}`);
  const assetRoot = resolve(assetsDirectory);
  const checksums = parseChecksums(await readFile(resolve(assetRoot, "SHA256SUMS"), "utf8"));
  const report = {};

  for (const [assetName, expectedSha] of checksums) {
    const assetPath = resolve(assetRoot, assetName);
    assert((await stat(assetPath).catch(() => null))?.isFile(), `Staged checksum asset ${assetName} is missing.`);
    assert(await sha256File(assetPath) === expectedSha, `Staged checksum asset ${assetName} failed SHA-256 verification.`);
  }

  for (const [role, definition] of Object.entries(roles)) {
    const evidence = typeof evidenceByRole[role] === "string"
      ? JSON.parse(evidenceByRole[role])
      : evidenceByRole[role];
    assert(evidence?.schemaVersion === 1, `${role}: unsupported evidence schema.`);
    assert(evidence.tag === tag, `${role}: evidence tag does not match ${tag}.`);
    assert(evidence.commit === commit, `${role}: evidence commit does not match ${commit}.`);
    assert(evidence.bundleIdentifier === "com.corerobin.monitor", `${role}: unexpected bundle identifier.`);
    assert(evidence.platform === definition.platform, `${role}: expected platform ${definition.platform}.`);
    assert(evidence.architecture === definition.architecture, `${role}: expected architecture ${definition.architecture}.`);
    assert(evidence.result === "passed", `${role}: evidence is not marked passed.`);

    const artifactName = basename(evidence.artifact?.name ?? "");
    assert(definition.artifact.test(artifactName), `${role}: unexpected artifact ${artifactName}.`);
    const expectedSha = checksums.get(artifactName);
    assert(expectedSha, `${role}: ${artifactName} is missing from SHA256SUMS.`);
    assert(evidence.artifact.sha256 === expectedSha, `${role}: evidence SHA-256 does not match SHA256SUMS.`);
    const results = new Map((evidence.checks ?? []).map((check) => [check.id, check.status]));
    for (const check of commonChecks) assert(results.get(check) === "passed", `${role}: ${check} was not passed.`);
    for (const check of macOSChecks) {
      const expected = definition.platform === "darwin" ? "passed" : "not-applicable";
      assert(results.get(check) === expected, `${role}: ${check} must be ${expected}.`);
    }
    for (const check of macOSUninstallChecks) {
      const expected = definition.platform === "darwin" ? "passed" : "not-applicable";
      assert(results.get(check) === expected, `${role}: ${check} must be ${expected}.`);
    }
    for (const check of nativeUninstallChecks) {
      const expected = definition.platform === "darwin" ? "not-applicable" : "passed";
      assert(results.get(check) === expected, `${role}: ${check} must be ${expected}.`);
    }
    report[role] = { artifact: artifactName, sha256: expectedSha };
  }
  return report;
}

function parseChecksums(content) {
  const checksums = new Map();
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.match(/^([0-9a-f]{64})\s+\*?(.+)$/);
    if (!match) throw new Error(`Invalid SHA256SUMS line: ${line}`);
    const name = basename(match[2]);
    if (checksums.has(name)) throw new Error(`Duplicate checksum asset: ${name}`);
    checksums.set(name, match[1]);
  }
  return checksums;
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , tag, commit, assetsDirectory] = process.argv;
  if (!tag || !commit || !assetsDirectory) {
    console.error("Usage: node scripts/verify-release-smoke-evidence.mjs TAG COMMIT ASSETS_DIRECTORY");
    process.exitCode = 2;
  } else {
    try {
      const evidenceByRole = Object.fromEntries(
        Object.entries(roles).map(([role, definition]) => {
          const value = process.env[definition.environment];
          if (!value) throw new Error(`Missing ${definition.environment}.`);
          return [role, value];
        }),
      );
      const report = await verifyReleaseSmokeEvidence({ tag, commit, assetsDirectory, evidenceByRole });
      console.log(JSON.stringify(report, null, 2));
      console.log(`Verified four real-device smoke records for ${tag} at ${commit}.`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  }
}
