import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

const INSTALLER_PATTERNS = [/\.dmg$/i, /\.deb$/i, /\.AppImage$/, /\.exe$/i, /\.msi$/i];

export async function preparePreviewAssets({ tag, artifactsRoot, outputRoot }) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag ?? "")) throw new Error(`Invalid stable release tag: ${tag}`);
  const files = await listFiles(artifactsRoot);
  const selected = files.filter((path) => INSTALLER_PATTERNS.some((pattern) => pattern.test(path)));
  const platformCounts = {
    macos: selected.filter((path) => path.includes("corerobin-macos-") && path.endsWith(".dmg")).length,
    linux: selected.filter((path) => path.includes("corerobin-linux-")).length,
    windows: selected.filter((path) => path.includes("corerobin-windows-")).length,
  };
  if (platformCounts.macos !== 2 || platformCounts.linux < 1 || platformCounts.windows < 1) {
    throw new Error(`Preview requires two macOS DMGs plus Linux and Windows installers: ${JSON.stringify(platformCounts)}`);
  }

  await mkdir(outputRoot, { recursive: true });
  const destinations = [];
  const names = new Set();
  for (const source of selected) {
    const originalName = basename(source);
    const name = originalName.endsWith(".dmg")
      ? originalName.replace(/\.dmg$/i, "_unnotarized-preview.dmg")
      : originalName;
    if (names.has(name)) throw new Error(`Preview assets must have unique names: ${name}`);
    names.add(name);
    const destination = join(outputRoot, name);
    await copyFile(source, destination);
    destinations.push(destination);
  }

  destinations.sort((left, right) => basename(left).localeCompare(basename(right)));
  const checksums = [];
  for (const path of destinations) {
    checksums.push(`${await sha256(path)}  ${basename(path)}`);
  }
  await writeFile(join(outputRoot, "PREVIEW-SHA256SUMS"), `${checksums.join("\n")}\n`);
  return { files: destinations.map((path) => basename(path)), platformCounts };
}

async function listFiles(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function run() {
  const [tag, artifactsRoot, outputRoot] = process.argv.slice(2);
  if (!tag || !artifactsRoot || !outputRoot) {
    throw new Error("Usage: prepare-preview-assets.mjs vMAJOR.MINOR.PATCH ARTIFACTS_ROOT OUTPUT_ROOT");
  }
  const result = await preparePreviewAssets({ tag, artifactsRoot, outputRoot });
  console.log(`Prepared ${result.files.length} manual-download Preview installers.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await run();
}
