import { readdir, rename } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

export async function flattenReleaseArtifacts(root) {
  const files = (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  const byName = new Map();
  for (const path of files) {
    const name = basename(path);
    const existing = byName.get(name);
    if (existing) {
      throw new Error(
        `Release assets must have unique public names; ${name} appears at ${relative(root, existing)} and ${relative(root, path)}.`,
      );
    }
    byName.set(name, path);
  }

  let moved = 0;
  for (const [name, path] of byName) {
    const destination = join(root, name);
    if (path !== destination) {
      await rename(path, destination);
      moved += 1;
    }
  }
  return { files: byName.size, moved };
}

async function run() {
  const [root] = process.argv.slice(2);
  if (!root) throw new Error("Usage: node scripts/flatten-release-artifacts.mjs <artifacts-root>");
  const result = await flattenReleaseArtifacts(root);
  console.log(`Prepared ${result.files} uniquely named public assets (${result.moved} moved).`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await run();
}
