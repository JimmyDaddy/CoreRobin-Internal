import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const VERSION_FILES = {
  packageJson: "package.json",
  tauriConfig: "src-tauri/tauri.conf.json",
  cargoManifest: "src-tauri/Cargo.toml",
  cargoLock: "src-tauri/Cargo.lock",
};

export function prepareReleaseFiles(files, version) {
  assertVersion(version);
  const packageJson = JSON.parse(files.packageJson);
  packageJson.version = version;
  const tauriConfig = JSON.parse(files.tauriConfig);
  tauriConfig.version = version;
  return {
    packageJson: `${JSON.stringify(packageJson, null, 2)}\n`,
    tauriConfig: `${JSON.stringify(tauriConfig, null, 2)}\n`,
    cargoManifest: replaceTomlPackageVersion(files.cargoManifest, "[package]", undefined, version),
    cargoLock: replaceTomlPackageVersion(files.cargoLock, "[[package]]", "core-robin", version),
  };
}

export async function prepareReleaseVersion(version, repositoryRoot = process.cwd()) {
  assertVersion(version);
  const entries = await Promise.all(Object.entries(VERSION_FILES).map(async ([key, path]) => [
    key,
    await readFile(new URL(path, pathToFileURL(`${repositoryRoot}/`)), "utf8"),
  ]));
  const prepared = prepareReleaseFiles(Object.fromEntries(entries), version);
  await Promise.all(Object.entries(VERSION_FILES).map(([key, path]) =>
    writeFile(new URL(path, pathToFileURL(`${repositoryRoot}/`)), prepared[key])));
  const notesRoot = resolve(repositoryRoot, "release-notes");
  await mkdir(notesRoot, { recursive: true });
  await writeFile(
    resolve(notesRoot, `v${version}.json`),
    `${JSON.stringify(publicReleaseNoteTemplate(version), null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  ).catch((error) => {
    if (error?.code !== "EEXIST") throw error;
  });
  return version;
}

export function publicReleaseNoteTemplate(version) {
  assertVersion(version);
  return {
    schemaVersion: 1,
    tagName: `v${version}`,
    title: { "zh-CN": "", en: "" },
    items: [],
  };
}

function replaceTomlPackageVersion(source, heading, packageName, version) {
  const escapedHeading = heading.replaceAll("[", "\\[").replaceAll("]", "\\]");
  const blocks = [...source.matchAll(new RegExp(
    `^${escapedHeading}\\s*$[\\s\\S]*?(?=^\\[|(?![\\s\\S]))`,
    "gm",
  ))];
  const matching = blocks.filter((match) =>
    packageName === undefined || new RegExp(`^name\\s*=\\s*"${packageName}"$`, "m").test(match[0]));
  if (matching.length !== 1) {
    throw new Error(`Expected exactly one ${packageName ?? "root"} package block in ${heading}.`);
  }
  const block = matching[0][0];
  const versions = [...block.matchAll(/^version\s*=\s*"[^"]+"$/gm)];
  if (versions.length !== 1) throw new Error(`Expected exactly one package version in ${heading}.`);
  const updatedBlock = block.replace(/^version\s*=\s*"[^"]+"$/m, `version = "${version}"`);
  return `${source.slice(0, matching[0].index)}${updatedBlock}${source.slice(matching[0].index + block.length)}`;
}

function assertVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
    throw new Error(`Release version must use the exact MAJOR.MINOR.PATCH format: ${version ?? ""}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const version = process.argv[2];
  if (!version) {
    console.error("Usage: node scripts/prepare-release.mjs MAJOR.MINOR.PATCH");
    process.exitCode = 2;
  } else {
    try {
      await prepareReleaseVersion(version);
      console.log(`Prepared CoreRobin ${version} in all four version sources.`);
      console.log(`Complete release-notes/v${version}.json, mirror its Chinese product items in CHANGELOG.md, then run pnpm release:preflight before creating a tag.`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  }
}
