import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

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
  const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
  const tauriVersion = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")).version;
  const cargoManifest = readFileSync("src-tauri/Cargo.toml", "utf8");
  const cargoVersion = cargoManifest.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  if (!cargoVersion) throw new Error("Could not read the package version from src-tauri/Cargo.toml.");
  assertMatchingVersions(expectedVersion, {
    "package.json": packageVersion,
    "src-tauri/tauri.conf.json": tauriVersion,
    "src-tauri/Cargo.toml": cargoVersion,
  });
  return { expectedVersion, tagCommit, trustedRef };
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
