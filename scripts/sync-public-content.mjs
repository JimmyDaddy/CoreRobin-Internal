import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const options = parseOptions(process.argv.slice(2));

if (!options.output) {
  throw new Error("Use --output <public-repository-path> to select an explicit sync destination.");
}

const outputRoot = resolve(options.output);
const outputStat = await stat(outputRoot).catch(() => null);
if (!outputStat?.isDirectory()) {
  throw new Error(`Public sync destination is not an existing directory: ${outputRoot}`);
}

const sourceFiles = [
  ["docs/user-guide.md", "docs/user-guide.md"],
  ["docs/user-guide.zh-CN.md", "docs/user-guide.zh-CN.md"],
  ["docs/privacy.md", "docs/privacy.md"],
  ["docs/privacy.zh-CN.md", "docs/privacy.zh-CN.md"],
  ["docs/privacy.md", "PRIVACY.en.md"],
  ["docs/privacy.zh-CN.md", "PRIVACY.md"],
];

const renderedFiles = await Promise.all(sourceFiles.map(async ([source, destination]) => {
  const content = normalizeMarkdown(await readFile(resolve(repositoryRoot, source), "utf8"));
  return { source, destination, content, sha256: sha256(content) };
}));

const manifest = {
  schemaVersion: 1,
  source: "Internal documentation source",
  generator: "scripts/sync-public-content.mjs",
  files: Object.fromEntries(renderedFiles.map(({ destination, sha256: digest }) => [destination, { sha256: digest }])),
};
const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
const outputFiles = [
  ...renderedFiles.map(({ destination, content }) => ({ destination, content })),
  { destination: "docs/.source-manifest.json", content: manifestContent },
];

if (options.check) {
  const mismatches = [];
  for (const { destination, content } of outputFiles) {
    const outputPath = resolve(outputRoot, destination);
    const current = await readFile(outputPath, "utf8").catch(() => null);
    if (current !== content) mismatches.push(relative(outputRoot, outputPath));
  }
  if (mismatches.length > 0) {
    throw new Error(`Public content is out of sync: ${mismatches.join(", ")}`);
  }
  console.log(`Verified ${outputFiles.length} public content files against Internal.`);
} else {
  for (const { destination, content } of outputFiles) {
    const outputPath = resolve(outputRoot, destination);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, content, "utf8");
  }
  console.log(`Synced ${outputFiles.length} public content files to ${outputRoot}.`);
}

function parseOptions(args) {
  const options = { check: false, output: null };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--check") {
      options.check = true;
      continue;
    }
    if (argument === "--output") {
      options.output = args[index + 1] ?? null;
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }
  return options;
}

function normalizeMarkdown(content) {
  return `${content.replace(/\r\n/g, "\n").replace(/\n*$/, "")}\n`;
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}
