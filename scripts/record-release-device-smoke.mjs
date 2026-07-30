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
  { id: "companion", title: "Robin 小伙伴可显示、展开、拖动、隐藏，并可通过双击或菜单打开主窗口" },
  { id: "health-sync", title: "主窗口、状态栏面板与 Robin 显示同一稳定状态、原因和更新时间" },
  { id: "appearance-sync", title: "切换语言、文字大小和减少动画后，三个前端在重新打开时保持一致" },
  { id: "background", title: "关闭主窗口后后台采样继续，状态栏仍可恢复主窗口" },
  {
    id: "updater-discovery",
    title: "关于与支持能完成更新检查，准确显示当前版本、可用版本或已是最新版，不出现原始系统错误",
  },
  {
    id: "updater-notification",
    title: "新版本提示不会阻塞主窗口；可选择立即更新、明天提醒或跳过当前版本，跳过后更高版本仍会提示",
  },
  {
    id: "updater-install-restart",
    title: "另行安装上一稳定版并通过正式更新通道下载更新；安装完成后点击重启，新版本自动打开且语言、主题和本机历史仍保留",
  },
  {
    id: "application-uninstall-capability",
    title: "应用页能读取当前平台的真实清单；读取失败与“没有安装应用”明确区分，名称、图标和安装来源符合系统信息",
  },
  {
    id: "removable-volume-eject",
    title: "连接专门用于验收的可移除卷后，在存储页确认推出；卷从 CoreRobin 与系统中消失，重新连接后可再次显示",
  },
  {
    id: "today-review",
    title: "日常模式的“回顾”能汇总当天事件、恢复与已确认操作；效果文案只描述观察结果，不虚构因果关系",
  },
  {
    id: "weekly-review-export",
    title: "回顾页能分别比较今天、昨天和过去七天；可导出 CSV/JSON，默认不包含应用名称、命令行、完整路径或连接地址",
  },
  {
    id: "cleanup-scan-lifecycle",
    title: "长时间空间扫描中切换页面、隐藏窗口或重载主界面后仍能恢复同一任务；停止能在明确时间内结束，随后可立即重新扫描",
  },
  {
    id: "native-process-request-close",
    title: "对专门的验收应用执行“请求结束”，系统确认目标身份未变化并让应用正常退出；无可关闭窗口或权限不足时显示明确原因",
    platforms: ["win32", "linux"],
  },
  {
    id: "native-process-restart",
    title: "重新启动专门的验收应用时，CoreRobin 先确认原进程退出，再从已验证的可执行文件启动新进程；PID 变化且没有结束其他进程",
    platforms: ["win32", "linux"],
  },
  {
    id: "native-process-force-kill",
    title: "仅对专门的无响应验收应用执行强制结束；稳定句柄仍指向原进程，权限拒绝与进程已退出能被区分",
    platforms: ["win32", "linux"],
  },
  {
    id: "application-uninstall-review",
    title: "选择一个非 CoreRobin 应用后可看到本体与关联数据，打开卸载复核并安全取消，应用与文件保持不变",
    platforms: ["darwin"],
  },
  {
    id: "native-application-uninstall-review",
    title: "选择一个专门用于验收的可移除应用，能看到系统包身份、卸载方式和提权说明；取消 CoreRobin 复核后不会启动卸载",
    platforms: ["win32", "linux"],
  },
  {
    id: "native-application-uninstall-cancel",
    title: "对验收应用启动系统卸载后，在 UAC/PolicyKit 或系统安装器中取消；CoreRobin 明确显示已取消而不是失败",
    platforms: ["win32", "linux"],
  },
  {
    id: "native-application-uninstall-complete",
    title: "重新安装验收应用并完成系统卸载；返回 CoreRobin 后该应用重新枚举为已移除，其他应用清单不受影响",
    platforms: ["win32", "linux"],
  },
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
