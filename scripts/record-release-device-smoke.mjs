import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { arch, platform, release, version as osVersion } from "node:os";
import { basename, resolve } from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { execFileSync } from "node:child_process";

const options = parseOptions(process.argv.slice(2));
const checks = [
  { id: "launch", title: "安装后的应用能够启动；启动页关闭并显示主窗口" },
  { id: "main", title: "主窗口能在日常/专业模式间切换且无空白或脚本错误" },
  { id: "tray", title: "状态栏/托盘面板可打开、关闭并再次打开，内容没有截断" },
  { id: "companion", title: "Robin 小伙伴可显示、展开、拖动、隐藏并打开主窗口" },
  { id: "health-sync", title: "主窗口、状态栏面板与 Robin 显示同一稳定状态、原因和更新时间" },
  { id: "appearance-sync", title: "切换语言、文字大小和减少动画后，三个前端在重新打开时保持一致" },
  { id: "background", title: "关闭主窗口后后台采样继续，状态栏仍可恢复主窗口" },
  { id: "cleanup-limited", title: "暂不授权完整磁盘访问时，仍可扫描可访问区域并清楚说明范围", platforms: ["darwin"] },
  { id: "cleanup-authorized", title: "授予完整磁盘访问并重新启动后，可执行全磁盘扫描且进度持续更新", platforms: ["darwin"] },
  { id: "quit-relaunch", title: "退出应用会关闭所有前端；重新启动后偏好与非敏感历史按设置恢复" },
];

if (options.dryRun) {
  console.log(JSON.stringify({ schemaVersion: 1, checks }, null, 2));
  process.exit(0);
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  throw new Error("Real-device smoke requires an interactive terminal. Use --dry-run only to validate the checklist in CI.");
}
if (!options.tag || !/^v\d+\.\d+\.\d+$/.test(options.tag) || !options.artifact || !options.app) {
  throw new Error("Usage: pnpm release:smoke:device -- --tag vMAJOR.MINOR.PATCH --artifact INSTALLER --app INSTALLED_APP [--output FILE]");
}

const artifactPath = resolve(options.artifact);
const appPath = resolve(options.app);
if (!(await stat(artifactPath).catch(() => null))?.isFile()) {
  throw new Error(`Release artifact is not a file: ${artifactPath}`);
}
if (!(await stat(appPath).catch(() => null))) {
  throw new Error(`Installed application was not found: ${appPath}`);
}

launchApplication(appPath);
const terminal = createInterface({ input: process.stdin, output: process.stdout });
await terminal.question("应用已启动。请等待界面稳定后按回车开始逐项验证。 ");

const results = [];
for (const check of checks) {
  const applicable = !check.platforms || check.platforms.includes(platform());
  if (!applicable) {
    results.push({ id: check.id, status: "not-applicable", note: `Not applicable on ${platform()}.` });
    continue;
  }
  let answer = "";
  while (!/^[pfn]$/i.test(answer)) {
    answer = (await terminal.question(`\n${check.title}\n[p]通过 / [f]失败 / [n]无法验证： `)).trim();
  }
  const status = ({ p: "passed", f: "failed", n: "not-verified" })[answer.toLowerCase()];
  const note = status === "passed" ? "" : (await terminal.question("请记录现象或阻塞原因： ")).trim();
  results.push({ id: check.id, status, note });
}
terminal.close();

const artifactSha256 = await sha256File(artifactPath);
const commit = git(["rev-parse", "HEAD"]);
const evidence = {
  schemaVersion: 1,
  product: "CoreRobin",
  bundleIdentifier: "com.corerobin.monitor",
  capturedAt: new Date().toISOString(),
  tag: options.tag,
  commit,
  platform: platform(),
  platformRelease: release(),
  platformVersion: osVersion(),
  architecture: arch(),
  artifact: {
    name: basename(artifactPath),
    sha256: artifactSha256,
  },
  applicationPath: appPath,
  result: results.every(({ status }) => status === "passed" || status === "not-applicable") ? "passed" : "failed",
  checks: results,
};

const outputPath = resolve(options.output ?? `.local-dev/release-smoke/${new Date().toISOString().replaceAll(":", "-")}.json`);
await mkdir(resolve(outputPath, ".."), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
console.log(`\nRecorded ${evidence.result} real-device smoke evidence at ${outputPath}.`);
if (evidence.result !== "passed") process.exitCode = 1;

function parseOptions(args) {
  const parsed = { tag: null, artifact: null, app: null, output: null, dryRun: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") continue;
    if (argument === "--dry-run") parsed.dryRun = true;
    else if (["--tag", "--artifact", "--app", "--output"].includes(argument)) {
      const key = argument.slice(2);
      parsed[key] = args[index + 1] ?? null;
      index += 1;
    } else throw new Error(`Unknown option: ${argument}`);
  }
  return parsed;
}

function launchApplication(path) {
  if (platform() === "darwin") {
    const child = spawn("open", ["-n", path], { detached: true, stdio: "ignore" });
    child.unref();
    return;
  }
  const child = spawn(path, [], { detached: true, stdio: "ignore" });
  child.unref();
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function git(args) {
  return execFileSync("git", args, { cwd: resolve(import.meta.dirname, ".."), encoding: "utf8" }).trim();
}
