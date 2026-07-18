import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

const BUNDLE_IDENTIFIER = "com.corerobin.monitor";

export function localMacOSAssetNames(tag) {
  const version = releaseVersion(tag);
  return [
    `CoreRobin_${version}_aarch64.dmg`,
    `CoreRobin_${version}_aarch64.app.tar.gz`,
    `CoreRobin_${version}_aarch64.app.tar.gz.sig`,
    `CoreRobin_${version}_x64.dmg`,
    `CoreRobin_${version}_x64.app.tar.gz`,
    `CoreRobin_${version}_x64.app.tar.gz.sig`,
  ];
}

export function localMacOSManifestName(tag) {
  return `CoreRobin_${releaseVersion(tag)}_macos-local.json`;
}

export async function createLocalMacOSManifest({ tag, commit, teamId, assetsRoot }) {
  validateReleaseIdentity({ tag, commit, teamId });
  const artifacts = [];
  for (const name of localMacOSAssetNames(tag)) {
    artifacts.push({ name, sha256: await sha256(join(assetsRoot, name)) });
  }

  const manifest = {
    schemaVersion: 1,
    builder: "local-macos",
    tag,
    version: releaseVersion(tag),
    commit,
    bundleIdentifier: BUNDLE_IDENTIFIER,
    teamId,
    builtAt: new Date().toISOString(),
    artifacts,
  };
  const path = join(assetsRoot, localMacOSManifestName(tag));
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  return { manifest, path };
}

export async function verifyLocalMacOSManifest({ tag, commit, assetsRoot }) {
  validateReleaseIdentity({ tag, commit });
  const path = join(assetsRoot, localMacOSManifestName(tag));
  const manifest = JSON.parse(await readFile(path, "utf8"));
  if (manifest.schemaVersion !== 1 || manifest.builder !== "local-macos") {
    throw new Error("Unsupported local macOS build manifest.");
  }
  if (manifest.tag !== tag || manifest.version !== releaseVersion(tag) || manifest.commit !== commit) {
    throw new Error("Local macOS build manifest does not match the requested release source.");
  }
  if (manifest.bundleIdentifier !== BUNDLE_IDENTIFIER || !/^[A-Z0-9]{10}$/.test(manifest.teamId ?? "")) {
    throw new Error("Local macOS build manifest has an invalid signing identity.");
  }
  if (!Number.isFinite(Date.parse(manifest.builtAt)) || !Array.isArray(manifest.artifacts)) {
    throw new Error("Local macOS build manifest metadata is invalid.");
  }

  const expectedNames = localMacOSAssetNames(tag);
  const actualNames = manifest.artifacts.map((artifact) => artifact?.name);
  if (new Set(actualNames).size !== expectedNames.length || actualNames.join("\n") !== expectedNames.join("\n")) {
    throw new Error("Local macOS build manifest does not contain the exact expected assets.");
  }
  for (const artifact of manifest.artifacts) {
    if (!/^[0-9a-f]{64}$/.test(artifact.sha256 ?? "")) {
      throw new Error(`Local macOS asset has an invalid SHA-256: ${artifact.name}`);
    }
    const actual = await sha256(join(assetsRoot, basename(artifact.name)));
    if (actual !== artifact.sha256) {
      throw new Error(`Local macOS asset checksum mismatch: ${artifact.name}`);
    }
  }
  return manifest;
}

function validateReleaseIdentity({ tag, commit, teamId }) {
  releaseVersion(tag);
  if (!/^[0-9a-f]{40}$/.test(commit ?? "")) throw new Error(`Invalid release commit: ${commit}`);
  if (teamId !== undefined && !/^[A-Z0-9]{10}$/.test(teamId)) {
    throw new Error(`Invalid Apple Team ID: ${teamId}`);
  }
}

function releaseVersion(tag) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag ?? "")) throw new Error(`Invalid stable release tag: ${tag}`);
  return tag.slice(1);
}

async function sha256(path) {
  const content = await readFile(path);
  return createHash("sha256").update(content).digest("hex");
}

async function run() {
  const [command, tag, commit, fourth, fifth] = process.argv.slice(2);
  if (command === "create" && tag && commit && fourth && fifth) {
    const result = await createLocalMacOSManifest({ tag, commit, teamId: fourth, assetsRoot: fifth });
    console.log(`Created ${basename(result.path)} for ${result.manifest.artifacts.length} macOS assets.`);
    return;
  }
  if (command === "verify" && tag && commit && fourth && !fifth) {
    const manifest = await verifyLocalMacOSManifest({ tag, commit, assetsRoot: fourth });
    console.log(`Verified ${manifest.artifacts.length} local macOS assets for ${tag}.`);
    return;
  }
  throw new Error(
    "Usage: local-macos-release-manifest.mjs create TAG COMMIT TEAM_ID ASSETS_ROOT | verify TAG COMMIT ASSETS_ROOT",
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await run();
}
