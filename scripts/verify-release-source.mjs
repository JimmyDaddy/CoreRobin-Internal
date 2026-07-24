import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { readPublicReleaseNote } from "./public-release-notes.mjs";

export function versionFromReleaseTag(tag) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
    throw new Error(`Release tag must use the exact vMAJOR.MINOR.PATCH format: ${tag}`);
  }
  return tag.slice(1);
}

export function assertMatchingVersions(expected, versions) {
  const mismatches = Object.entries(versions).filter(([, version]) => version !== expected);
  if (mismatches.length === 0) return;
  const details = mismatches.map(([source, version]) => `${source}=${version}`).join(", ");
  throw new Error(`Release tag expects ${expected}, but project versions differ: ${details}`);
}

export function readProjectVersions(repositoryRoot = process.cwd()) {
  const packageVersion = JSON.parse(
    readFileSync(resolve(repositoryRoot, "package.json"), "utf8"),
  ).version;
  const tauriVersion = JSON.parse(
    readFileSync(resolve(repositoryRoot, "src-tauri/tauri.conf.json"), "utf8"),
  ).version;
  const cargoManifest = readFileSync(resolve(repositoryRoot, "src-tauri/Cargo.toml"), "utf8");
  const cargoVersion = cargoManifest.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  if (!cargoVersion) throw new Error("Could not read the package version from src-tauri/Cargo.toml.");
  const cargoLock = readFileSync(resolve(repositoryRoot, "src-tauri/Cargo.lock"), "utf8");
  const cargoLockVersion = packageVersionFromLock(cargoLock, "core-robin");
  return {
    "package.json": packageVersion,
    "src-tauri/tauri.conf.json": tauriVersion,
    "src-tauri/Cargo.toml": cargoVersion,
    "src-tauri/Cargo.lock": cargoLockVersion,
  };
}

export function assertReleaseChangelog(version, changelog) {
  const escapedVersion = version.replaceAll(".", "\\.");
  const heading = new RegExp(`^##\\s+${escapedVersion}(?:\\s|—|$).*`, "m");
  const match = changelog.match(heading);
  if (!match || match.index === undefined) {
    throw new Error(`CHANGELOG.md does not contain a release section for ${version}.`);
  }
  const bodyStart = match.index + match[0].length;
  const remaining = changelog.slice(bodyStart);
  const nextHeading = remaining.search(/^##\s+/m);
  const body = (nextHeading < 0 ? remaining : remaining.slice(0, nextHeading)).trim();
  if (!body) throw new Error(`CHANGELOG.md release section for ${version} is empty.`);
}

export function verifyReleaseReadiness(expectedVersion, repositoryRoot = process.cwd()) {
  if (!/^\d+\.\d+\.\d+$/.test(expectedVersion)) {
    throw new Error(`Release version must use the exact MAJOR.MINOR.PATCH format: ${expectedVersion}`);
  }
  const versions = readProjectVersions(repositoryRoot);
  assertMatchingVersions(expectedVersion, versions);
  const changelog = readFileSync(resolve(repositoryRoot, "CHANGELOG.md"), "utf8");
  assertReleaseChangelog(expectedVersion, changelog);
  const releaseNote = readPublicReleaseNote(`v${expectedVersion}`, repositoryRoot);
  return { expectedVersion, versions, releaseNote };
}

export function commitBelongsToTrustedRef(commit, trustedRef, git = runGit) {
  try {
    git(["merge-base", "--is-ancestor", commit, trustedRef]);
    return true;
  } catch {
    return false;
  }
}

export function verifyReleaseSource(tag, trustedRef, git = runGit) {
  const expectedVersion = versionFromReleaseTag(tag);
  const tagCommit = git(["rev-list", "-n", "1", tag]).trim();
  const checkedOutCommit = git(["rev-parse", "HEAD"]).trim();
  if (!tagCommit || tagCommit !== checkedOutCommit) {
    throw new Error(`Checked-out commit ${checkedOutCommit} does not match ${tag} (${tagCommit}).`);
  }
  if (!commitBelongsToTrustedRef(tagCommit, trustedRef, git)) {
    throw new Error(`Release commit ${tagCommit} is not reachable from trusted ref ${trustedRef}.`);
  }
  verifyReleaseReadiness(expectedVersion);
  return { expectedVersion, tagCommit, trustedRef };
}

function packageVersionFromLock(cargoLock, packageName) {
  const packageBlocks = cargoLock.match(/\[\[package\]\][\s\S]*?(?=\n\[\[package\]\]|$)/g) ?? [];
  const packageBlock = packageBlocks.find((block) =>
    new RegExp(`^name\\s*=\\s*"${packageName}"$`, "m").test(block));
  const version = packageBlock?.match(/^version\s*=\s*"([^"]+)"$/m)?.[1];
  if (!version) throw new Error(`Could not read ${packageName} version from src-tauri/Cargo.lock.`);
  return version;
}

function runGit(arguments_) {
  return execFileSync("git", arguments_, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , tag, trustedRef] = process.argv;
  if (!tag || !trustedRef) {
    console.error("Usage: node scripts/verify-release-source.mjs TAG TRUSTED_REF");
    process.exitCode = 2;
  } else {
    try {
      const result = verifyReleaseSource(tag, trustedRef);
      console.log(
        `Verified ${tag} (${result.expectedVersion}) at ${result.tagCommit} on ${result.trustedRef}.`,
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  }
}
