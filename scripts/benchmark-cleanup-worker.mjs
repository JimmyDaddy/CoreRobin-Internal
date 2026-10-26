import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { performance } from "node:perf_hooks";

// Explicit fixture root only. All mutable job/index files live in a fresh
// private temporary directory; this never opens the user's application index.
const [binaryArg, rootArg, timeoutArg = "900000"] = process.argv.slice(2);
if (!binaryArg || !rootArg || !/^\d+$/.test(timeoutArg) || Number(timeoutArg) < 1000) {
  throw new Error("Usage: node scripts/benchmark-cleanup-worker.mjs WORKER_BINARY FIXTURE_ROOT [TIMEOUT_MS]");
}
const binary = resolve(binaryArg);
const root = resolve(rootArg);
if (!(await stat(root)).isDirectory()) throw new Error("Fixture root must be a directory.");
const privateDirectory = await mkdtemp(join(tmpdir(), "corerobin-worker-benchmark-"));
let child;
try {
  const request = join(privateDirectory, "request.json");
  const result = join(privateDirectory, "benchmark.result.json");
  const index = join(privateDirectory, "index.sqlite");
  const exclusions = join(privateDirectory, "exclusions.json");
  await writeFile(request, JSON.stringify({ operation: "scan", request: {
    profile: "complete", targetKind: "folder", targetPath: root,
  } }), { mode: 0o600 });
  await writeFile(exclusions, "[]", { mode: 0o600 });
  const started = performance.now();
  let firstProgressMs = null;
  let firstCheckpointMs = null;
  let resultReadyMs = null;
  let longestNoWorkMs = 0;
  let lastWorkMs = 0;
  let lastEntries = -1;
  let lastPath = "";
  let checkpoints = 0;
  let failure = null;
  let stderr = "";
  let payload;
  child = spawn(binary, ["--cleanup-scan-worker", request, result, index, exclusions], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", (bytes) => { stderr = (stderr + bytes).slice(-8192); });
  const timeout = setTimeout(() => {
    failure = "worker_timeout";
    child.kill("SIGKILL");
  }, Number(timeoutArg));
  const markWork = (now) => {
    longestNoWorkMs = Math.max(longestNoWorkMs, now - lastWorkMs);
    lastWorkMs = now;
  };
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    const now = performance.now() - started;
    if (event.kind === "progress") {
      firstProgressMs ??= now;
      if (lastEntries !== event.progress.scannedEntryCount || lastPath !== event.progress.currentPath) {
        markWork(now);
        lastEntries = event.progress.scannedEntryCount;
        lastPath = event.progress.currentPath;
      }
    } else if (event.kind === "checkpoint") {
      firstCheckpointMs ??= now;
      checkpoints += 1;
      markWork(now);
    } else if (event.kind === "activity" || event.kind === "finalizing") {
      markWork(now);
    } else if (event.kind === "completed") {
      resultReadyMs = now;
      markWork(now);
    } else if (event.kind === "failed") {
      failure = event.code;
    }
  });
  const exit = await new Promise((accept, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => accept({ code, signal }));
  }).finally(() => clearTimeout(timeout));
  if (exit.code !== 0 || failure || resultReadyMs === null) {
    throw new Error(JSON.stringify({ failure, exit, stderr, lastEntries, elapsedMs: performance.now() - started }));
  }
  payload = JSON.parse(await readFile(result, "utf8"));
  if (!payload.indexed || !payload.deletionAvailable || payload.partial) {
    throw new Error("Worker did not deliver a complete, usable indexed result.");
  }
  console.log(JSON.stringify({
    binary, root, firstProgressMs, firstCheckpointMs, resultReadyMs,
    processExitMs: performance.now() - started, longestNoWorkMs, checkpoints,
    scannedEntryCount: payload.scannedEntryCount, unreadableEntryCount: payload.unreadableEntryCount,
    allocatedBytes: payload.root.allocatedSizeBytes, indexBytes: (await stat(index)).size,
  }, null, 2));
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await new Promise((accept) => child.once("close", accept));
  }
  await rm(privateDirectory, { recursive: true, force: true });
}
