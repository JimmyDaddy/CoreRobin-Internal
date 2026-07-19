import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export function renderPreviewReleaseNotes(tag) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag ?? "")) throw new Error(`Invalid stable release tag: ${tag}`);
  return `CoreRobin ${tag} Preview\n\n这是等待 Apple 公证期间提供的公开测试候选版本，仅供主动参与测试的用户手动下载。\n\n## 重要说明\n\n- macOS DMG 已使用 Developer ID Application 签名，但尚未完成 Apple 公证与票据装订，Gatekeeper 可能阻止直接打开。\n- 此 Preview 不包含 \`latest.json\` 或应用内更新包，不会进入 CoreRobin 自动更新渠道。\n- 正式版本将在 Apple 公证完成、安装包校验和真实设备 smoke test 全部通过后，以独立的 \`${tag}\` Release 发布。\n- Preview 资产不会被静默替换；若候选版本发生变化，将发布新的 Preview 序号。\n`;
}

async function run() {
  const [tag, output] = process.argv.slice(2);
  if (!tag || !output) throw new Error("Usage: render-preview-release-notes.mjs vMAJOR.MINOR.PATCH OUTPUT");
  await writeFile(output, renderPreviewReleaseNotes(tag), "utf8");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await run();
}
