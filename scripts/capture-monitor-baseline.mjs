import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { resolve } from "node:path";

const options = parseOptions(process.argv.slice(2));
if (options.dryRun) {
  console.log(JSON.stringify({ schemaVersion: 1, runs: options.runs, iterations: options.iterations, spacingMilliseconds: options.spacing }, null, 2));
  process.exit(0);
}

const repositoryRoot = resolve(import.meta.dirname, "..");
const results = [];
for (let run = 1; run <= options.runs; run += 1) {
  console.error(`Capturing monitor baseline run ${run}/${options.runs}...`);
  const result = spawnSync(
    "cargo",
    [
      "run", "--quiet", "--locked", "--manifest-path", "src-tauri/Cargo.toml", "--release",
      "--example", "monitor-benchmark", "--", String(options.iterations), String(options.spacing),
    ],
    { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(`Monitor benchmark run ${run} failed:\n${result.stderr || result.stdout}`);
  }
  results.push(JSON.parse(result.stdout));
}

const evidence = {
  schemaVersion: 1,
  capturedAt: new Date().toISOString(),
  commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim(),
  environment: {
    platform: platform(),
    platformRelease: release(),
    architecture: arch(),
    logicalCpuCount: cpus().length,
    cpuModel: cpus()[0]?.model ?? null,
    totalMemoryBytes: totalmem(),
  },
  command: {
    runs: options.runs,
    iterations: options.iterations,
    spacingMilliseconds: options.spacing,
  },
  runs: results,
};
const outputPath = resolve(options.output ?? `.local-dev/performance/monitor-${evidence.capturedAt.replaceAll(":", "-")}.json`);
await mkdir(resolve(outputPath, ".."), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
console.log(outputPath);

function parseOptions(args) {
  const parsed = { runs: 3, iterations: 20, spacing: 250, output: null, dryRun: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") continue;
    if (argument === "--dry-run") parsed.dryRun = true;
    else if (["--runs", "--iterations", "--spacing", "--output"].includes(argument)) {
      const value = args[index + 1];
      if (value === undefined) throw new Error(`Missing value for ${argument}.`);
      const key = argument.slice(2);
      parsed[key] = key === "output" ? value : Number(value);
      index += 1;
    } else throw new Error(`Unknown option: ${argument}`);
  }
  for (const key of ["runs", "iterations", "spacing"]) {
    if (!Number.isInteger(parsed[key]) || parsed[key] <= 0) throw new Error(`${key} must be a positive integer.`);
  }
  return parsed;
}
