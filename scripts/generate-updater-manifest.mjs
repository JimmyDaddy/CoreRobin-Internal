import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const PUBLIC_RELEASE_REPOSITORY = "JimmyDaddy/corerobin-monitor";
const TARGETS = [
  {
    platform: "darwin-aarch64",
    artifactMarker: "corerobin-macos-aarch64",
    packagePattern: /\.app\.tar\.gz$/i,
    publicName: (version) => `CoreRobin_${version}_aarch64.app.tar.gz`,
  },
  {
    platform: "darwin-x86_64",
    artifactMarker: "corerobin-macos-x86_64",
    packagePattern: /\.app\.tar\.gz$/i,
    publicName: (version) => `CoreRobin_${version}_x64.app.tar.gz`,
  },
  {
    platform: "linux-x86_64",
    artifactMarker: "corerobin-linux-x86_64",
    packagePattern: /\.AppImage\.tar\.gz$/i,
    publicName: (version) => `CoreRobin_${version}_amd64.AppImage.tar.gz`,
  },
  {
    platform: "windows-x86_64",
    artifactMarker: "corerobin-windows-x86_64",
    packagePattern: /(?:-setup\.exe|\.nsis)\.zip$/i,
    publicName: (version) => `CoreRobin_${version}_x64-setup.nsis.zip`,
  },
];

export async function generateUpdaterManifest({
  tag,
  artifactsRoot,
  notes,
  pubDate,
}) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error(`Invalid stable release tag: ${tag}`);
  if (!Number.isFinite(Date.parse(pubDate))) throw new Error(`Invalid release date: ${pubDate}`);

  const version = tag.slice(1);
  const files = await listFiles(artifactsRoot);
  const packages = [];
  const platforms = {};

  for (const target of TARGETS) {
    const packagePath = findExactlyOne(
      files,
      (path) => path.includes(target.artifactMarker) && target.packagePattern.test(basename(path)),
      `${target.platform} updater package`,
    );
    const signaturePath = findExactlyOne(
      files,
      (path) => path.includes(target.artifactMarker) && basename(path) === `${basename(packagePath)}.sig`,
      `${target.platform} updater signature`,
    );
    const publicName = target.publicName(version);
    const publicPackagePath = join(artifactsRoot, publicName);
    const publicSignaturePath = `${publicPackagePath}.sig`;
    const signature = (await readFile(signaturePath, "utf8")).trim();
    if (!signature) throw new Error(`${target.platform} updater signature is empty.`);
    packages.push({ packagePath, signaturePath, publicPackagePath, publicSignaturePath });
    platforms[target.platform] = {
      signature,
      url: `https://github.com/${PUBLIC_RELEASE_REPOSITORY}/releases/download/${tag}/${publicName}`,
    };
  }

  for (const item of packages) {
    await rename(item.packagePath, item.publicPackagePath);
    await rename(item.signaturePath, item.publicSignaturePath);
  }

  const manifest = {
    version,
    notes: notes.trim(),
    pub_date: new Date(pubDate).toISOString(),
    platforms,
  };
  await writeFile(join(artifactsRoot, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

async function listFiles(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

function findExactlyOne(files, predicate, description) {
  const matches = files.filter(predicate);
  if (matches.length !== 1) {
    const listed = matches.length === 0
      ? "none"
      : matches.map((path) => relative(process.cwd(), path)).join(", ");
    throw new Error(`Expected exactly one ${description}; found ${matches.length}: ${listed}`);
  }
  return matches[0];
}

async function run() {
  const [tag, artifactsRoot, notesPath, pubDate] = process.argv.slice(2);
  if (!tag || !artifactsRoot || !notesPath || !pubDate) {
    throw new Error("Usage: node scripts/generate-updater-manifest.mjs vMAJOR.MINOR.PATCH <artifacts-root> <notes-file> <pub-date>");
  }
  const notes = await readFile(notesPath, "utf8");
  const manifest = await generateUpdaterManifest({ tag, artifactsRoot, notes, pubDate });
  console.log(`Generated signed updater manifest for ${Object.keys(manifest.platforms).length} targets.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await run();
}
