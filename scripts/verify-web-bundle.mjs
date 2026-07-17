import { readFile, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";

const repositoryRoot = resolve(import.meta.dirname, "..");
const distRoot = resolve(repositoryRoot, process.argv[2] ?? "dist");
const manifest = JSON.parse(await readFile(resolve(distRoot, ".vite/manifest.json"), "utf8"));
const budgets = JSON.parse(await readFile(resolve(repositoryRoot, "scripts/web-bundle-budgets.json"), "utf8"));
const tauriConfig = JSON.parse(await readFile(resolve(repositoryRoot, "src-tauri/tauri.conf.json"), "utf8"));

if (tauriConfig.identifier !== "com.corerobin.monitor") {
  throw new Error(`Unexpected Tauri identifier: ${tauriConfig.identifier}`);
}

const windowEntries = new Map(
  tauriConfig.app.windows.map((window) => [
    window.label,
    window.url ?? (window.label === "main" ? "index.html" : null),
  ]),
);
const expectedWindows = new Map([
  ["main", "index.html"],
  ["splashscreen", "splash.html"],
  ["tray", "tray.html"],
  ["companion", "companion.html"],
]);
for (const [label, entry] of expectedWindows) {
  if (windowEntries.get(label) !== entry) {
    throw new Error(`Tauri window ${label} must load ${entry}; received ${windowEntries.get(label)}`);
  }
}

const report = {};
for (const [entry, budget] of Object.entries(budgets.entries)) {
  const record = manifest[entry];
  if (!record?.isEntry) throw new Error(`Missing production manifest entry: ${entry}`);

  const html = await readFile(safeDistPath(entry), "utf8");
  if (/\/(?:src|@vite)\//.test(html)) {
    throw new Error(`${entry} still references a development source path.`);
  }
  if (!html.includes(record.file)) {
    throw new Error(`${entry} does not reference its production entry chunk ${record.file}.`);
  }

  const files = collectInitialFiles(entry);
  const measurements = {
    javascriptBytes: 0,
    javascriptGzipBytes: 0,
    cssBytes: 0,
    cssGzipBytes: 0,
  };
  for (const relativePath of files) {
    const content = await readFile(safeDistPath(relativePath));
    if (relativePath.endsWith(".js")) {
      measurements.javascriptBytes += content.byteLength;
      measurements.javascriptGzipBytes += gzipSync(content).byteLength;
    } else if (relativePath.endsWith(".css")) {
      measurements.cssBytes += content.byteLength;
      measurements.cssGzipBytes += gzipSync(content).byteLength;
    }
  }
  assertBudget(entry, measurements, budget);
  report[entry] = { ...measurements, initialFiles: files.length };
}

const allOutputFiles = new Set(
  Object.values(manifest).flatMap((record) => [record.file, ...(record.css ?? []), ...(record.assets ?? [])]),
);
const totals = { javascriptBytes: 0, cssBytes: 0 };
for (const relativePath of allOutputFiles) {
  const size = (await stat(safeDistPath(relativePath))).size;
  if (relativePath.endsWith(".js")) totals.javascriptBytes += size;
  if (relativePath.endsWith(".css")) totals.cssBytes += size;
}
assertBudget("all production chunks", totals, budgets.totals);

console.log(JSON.stringify({ schemaVersion: budgets.schemaVersion, entries: report, totals }, null, 2));
console.log("Verified four production WebView entries, Tauri window mapping, and bundle budgets.");

function collectInitialFiles(entry) {
  const files = new Set();
  const visited = new Set();
  const visit = (key) => {
    if (visited.has(key)) return;
    visited.add(key);
    const record = manifest[key];
    if (!record) throw new Error(`Manifest import ${key} referenced by ${entry} is missing.`);
    files.add(record.file);
    for (const css of record.css ?? []) files.add(css);
    for (const imported of record.imports ?? []) visit(imported);
  };
  visit(entry);
  return [...files].sort();
}

function safeDistPath(relativePath) {
  const absolute = resolve(distRoot, relativePath);
  if (absolute !== distRoot && !absolute.startsWith(`${distRoot}${sep}`)) {
    throw new Error(`Build output escapes dist: ${relativePath}`);
  }
  return absolute;
}

function assertBudget(scope, measurements, budget) {
  for (const [metric, limit] of Object.entries(budget)) {
    const actual = measurements[metric];
    if (!Number.isFinite(actual)) throw new Error(`${scope} did not produce ${metric}.`);
    if (actual > limit) {
      throw new Error(`${scope} ${metric} is ${actual} bytes, over its ${limit} byte budget.`);
    }
  }
}
