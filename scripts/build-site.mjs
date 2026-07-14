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

const files = await walk(outputRoot);
const htmlFiles = files.filter((path) => extname(path) === ".html");
for (const htmlFile of htmlFiles) {
  const html = await readFile(htmlFile, "utf8");
  const references = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((match) => match[1]);
  for (const reference of references) {
    if (/^(?:https?:|mailto:|#)/.test(reference)) continue;
    const [pathPart] = reference.split(/[?#]/, 1);
    if (!pathPart) continue;
    const target = resolve(dirname(htmlFile), pathPart);
    const resolvedTarget = pathPart.endsWith("/") ? join(target, "index.html") : target;
    try {
      const targetStat = await stat(resolvedTarget);
      if (!targetStat.isFile()) throw new Error("not a file");
    } catch {
      throw new Error(`Broken local reference in ${relative(repositoryRoot, htmlFile)}: ${reference}`);
    }
  }
}

console.log(`Built StatusOrbit site: ${files.length + 2} files, ${htmlFiles.length} HTML pages.`);

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  }));
  return nested.flat();
}
