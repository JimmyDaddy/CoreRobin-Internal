import { spawn, execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { resolve } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";

import { runtimeEnergyScenarios, summarizeEnergySamples } from "./runtime-energy-baseline.mjs";

const options = parseOptions(process.argv.slice(2));

if (options.dryRun) {
  console.log(JSON.stringify({
    schemaVersion: 1,
    requiredPlatform: "darwin",
    metrics: [
      "cpuPercent",
      "interruptWakeupsPerSecond",
      "packageIdleWakeupsPerSecond",
      "residentMemoryBytes",
      "energyImpact",
    ],
    scenarios: runtimeEnergyScenarios,
  }, null, 2));
  process.exit(0);
}

if (platform() !== "darwin") {
  throw new Error("Runtime energy baselines currently require a physical Mac and powermetrics.");
}
if (!Number.isInteger(options.pid) || options.pid <= 0 || !process.stdin.isTTY || !process.stdout.isTTY) {
  throw new Error("Usage: pnpm performance:energy -- --pid CORE_ROBIN_PID [--durations 300,600,120] [--output DIRECTORY]");
}
assertProcessExists(options.pid);
assertPowermetricsAuthorization();

const outputDirectory = resolve(
  options.output
    ?? `.local-dev/performance-energy/${new Date().toISOString().replaceAll(":", "-")}`,
);
await mkdir(outputDirectory, { recursive: true });
const terminal = createInterface({ input: process.stdin, output: process.stdout });
const scenarioResults = [];

try {
  for (let index = 0; index < runtimeEnergyScenarios.length; index += 1) {
    const scenario = runtimeEnergyScenarios[index];
    const durationSeconds = options.durations[index] ?? scenario.defaultDurationSeconds;
    await terminal.question(`\n${scenario.instruction}\n准备好后按回车，采样 ${durationSeconds} 秒。`);
    assertProcessExists(options.pid);
    const rawPath = resolve(outputDirectory, `${scenario.id}.powermetrics.plist`);
    const { raw, memorySamples } = await captureScenario(options.pid, durationSeconds);
    await writeFile(rawPath, raw);
    const parsedSamples = parsePowermetricsPlists(raw);
    const summary = summarizeEnergySamples(parsedSamples, options.pid, memorySamples);
    if (summary.powermetricsSampleCount === 0) {
      throw new Error(`powermetrics did not report PID ${options.pid} during ${scenario.id}.`);
    }
    scenarioResults.push({
      id: scenario.id,
      durationSeconds,
      rawPowermetricsPath: rawPath,
      summary,
    });
    console.log(`${scenario.id}: CPU ${formatAverage(summary.cpuPercent, "%")}, wakeups ${formatAverage(summary.interruptWakeupsPerSecond, "/s")}, RSS ${formatBytes(summary.residentMemoryBytes?.average)}`);
  }
} finally {
  terminal.close();
}

const evidence = {
  schemaVersion: 1,
  product: "CoreRobin",
  capturedAt: new Date().toISOString(),
  commit: git(["rev-parse", "HEAD"]),
  dirty: git(["status", "--porcelain"]).length > 0,
  pid: options.pid,
  process: processIdentity(options.pid),
  machine: {
    model: command("/usr/sbin/sysctl", ["-n", "hw.model"]),
    cpu: command("/usr/sbin/sysctl", ["-n", "machdep.cpu.brand_string"]),
    architecture: arch(),
    platformRelease: release(),
    macosVersion: command("/usr/bin/sw_vers", ["-productVersion"]),
    powerSource: command("/usr/bin/pmset", ["-g", "batt"]),
  },
  scenarios: scenarioResults,
};
const summaryPath = resolve(outputDirectory, "summary.json");
await writeFile(summaryPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
console.log(`\nRuntime energy baseline saved to ${summaryPath}.`);

function parseOptions(args) {
  const parsed = { pid: null, durations: [], output: null, dryRun: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") continue;
    if (argument === "--dry-run") parsed.dryRun = true;
    else if (argument === "--pid") parsed.pid = Number(args[++index]);
    else if (argument === "--output") parsed.output = args[++index] ?? null;
    else if (argument === "--durations") {
      parsed.durations = (args[++index] ?? "").split(",").map(Number);
      if (parsed.durations.length !== 3 || parsed.durations.some((value) => !Number.isInteger(value) || value < 2)) {
        throw new Error("--durations must contain three comma-separated values of at least 2 seconds.");
      }
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return parsed;
}

function assertPowermetricsAuthorization() {
  try {
    execFileSync("/usr/bin/sudo", ["-n", "true"], { stdio: "ignore" });
  } catch {
    throw new Error("powermetrics requires administrator access. Run `sudo -v` in this terminal, then retry; CoreRobin never receives or stores the password.");
  }
}

function assertProcessExists(pid) {
  try {
    execFileSync("/bin/ps", ["-p", String(pid), "-o", "pid="], { stdio: "ignore" });
  } catch {
    throw new Error(`Process ${pid} is not running.`);
  }
}

async function captureScenario(pid, durationSeconds) {
  const sampleRateMs = 1_000;
  const sampleCount = Math.max(2, Math.floor(durationSeconds * 1_000 / sampleRateMs));
  const memorySamples = [];
  const sampleMemory = () => {
    try {
      const [cpuPercent, rssKilobytes] = execFileSync(
        "/bin/ps",
        ["-p", String(pid), "-o", "%cpu=,rss="],
        { encoding: "utf8" },
      ).trim().split(/\s+/).map(Number);
      if (Number.isFinite(cpuPercent) && Number.isFinite(rssKilobytes)) {
        memorySamples.push({
          sampledAt: new Date().toISOString(),
          cpuPercent,
          rssBytes: rssKilobytes * 1_024,
        });
      }
    } catch {
      // The final process-existence check reports an actionable error.
    }
  };
  sampleMemory();
  const timer = setInterval(sampleMemory, sampleRateMs);
  const chunks = [];
  const child = spawn("/usr/bin/sudo", [
    "-n",
    "/usr/bin/powermetrics",
    "--samplers", "tasks",
    "--show-process-energy",
    "--show-process-coalition",
    "--format", "plist",
    "--sample-rate", String(sampleRateMs),
    "--sample-count", String(sampleCount),
  ], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => chunks.push(chunk));
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", resolveExit);
  }).finally(() => {
    clearInterval(timer);
    sampleMemory();
  });
  assertProcessExists(pid);
  if (exitCode !== 0) {
    throw new Error(`powermetrics failed with exit code ${exitCode}: ${stderr.trim()}`);
  }
  return { raw: Buffer.concat(chunks), memorySamples };
}

function parsePowermetricsPlists(buffer) {
  return buffer
    .toString("utf8")
    .split(/\0+/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => JSON.parse(execFileSync(
      "/usr/bin/plutil",
      ["-convert", "json", "-o", "-", "--", "-"],
      { input: chunk, encoding: "utf8" },
    )));
}

function processIdentity(pid) {
  return {
    command: execFileSync("/bin/ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" }).trim(),
  };
}

function command(binary, args) {
  return execFileSync(binary, args, { encoding: "utf8" }).trim();
}

function git(args) {
  return command("/usr/bin/git", args);
}

function formatAverage(metric, suffix) {
  return metric ? `${metric.average.toFixed(2)}${suffix}` : "n/a";
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return "n/a";
  return `${(value / 1_024 / 1_024).toFixed(1)} MB`;
}
