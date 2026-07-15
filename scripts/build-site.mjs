import { cp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(repositoryRoot, "site");
const outputRoot = join(repositoryRoot, "site-dist");

await rm(outputRoot, { recursive: true, force: true });
await cp(sourceRoot, outputRoot, { recursive: true });
await mkdir(join(outputRoot, "assets"), { recursive: true });
await cp(join(repositoryRoot, "src/assets/brand-mark.png"), join(outputRoot, "assets/brand-mark.png"));
await cp(join(repositoryRoot, "src-tauri/icons/icon.png"), join(outputRoot, "assets/app-icon.png"));

const screenshotAssets = [
  "statusorbit-daily-overview.jpg",
  "statusorbit-daily-assistant.jpg",
  "statusorbit-professional-overview.jpg",
  "statusorbit-professional-network.jpg",
  "statusorbit-space-sunburst.jpg",
];
for (const filename of screenshotAssets) {
  await cp(join(repositoryRoot, "docs/assets", filename), join(outputRoot, "assets", filename));
}

const files = await walk(outputRoot);
const htmlFiles = files.filter((path) => extname(path) === ".html");
const htmlInfoCache = new Map();

for (const htmlFile of htmlFiles) {
  await readHtmlInfo(htmlFile);
}

for (const htmlFile of htmlFiles) {
  const { references } = await readHtmlInfo(htmlFile);
  for (const reference of references) {
    if (/^(?:https?:|mailto:|tel:|data:|javascript:)/i.test(reference)) continue;

    const hashIndex = reference.indexOf("#");
    const rawFragment = hashIndex >= 0 ? reference.slice(hashIndex + 1) : "";
    const referenceWithoutFragment = hashIndex >= 0 ? reference.slice(0, hashIndex) : reference;
    const [pathPart] = referenceWithoutFragment.split("?", 1);
    const target = pathPart ? resolve(dirname(htmlFile), pathPart) : htmlFile;
    const resolvedTarget = pathPart?.endsWith("/") ? join(target, "index.html") : target;

    try {
      const targetStat = await stat(resolvedTarget);
      if (!targetStat.isFile()) throw new Error("not a file");
    } catch {
      throw new Error(`Broken local reference in ${relative(repositoryRoot, htmlFile)}: ${reference}`);
    }

    if (!rawFragment || extname(resolvedTarget) !== ".html") continue;
    let fragment;
    try {
      fragment = decodeURIComponent(rawFragment);
    } catch {
      throw new Error(`Invalid fragment in ${relative(repositoryRoot, htmlFile)}: ${reference}`);
    }
    const { ids } = await readHtmlInfo(resolvedTarget);
    if (!ids.has(fragment)) {
      throw new Error(`Broken fragment in ${relative(repositoryRoot, htmlFile)}: ${reference}`);
    }
  }
}

console.log(`Built StatusOrbit site: ${files.length} files, ${htmlFiles.length} HTML pages.`);

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  }));
  return nested.flat();
}

async function readHtmlInfo(path) {
  if (htmlInfoCache.has(path)) return htmlInfoCache.get(path);

  const html = await readFile(path, "utf8");
  const references = [...html.matchAll(/(?:href|src)=(['"])(.*?)\1/g)].map((match) => match[2]);
  const idValues = [...html.matchAll(/\bid=(['"])(.*?)\1/g)].map((match) => match[2]);
  const ids = new Set();
  for (const id of idValues) {
    if (ids.has(id)) {
      throw new Error(`Duplicate id in ${relative(repositoryRoot, path)}: ${id}`);
    }
    ids.add(id);
  }

  const info = { references, ids };
  htmlInfoCache.set(path, info);
  return info;
}
