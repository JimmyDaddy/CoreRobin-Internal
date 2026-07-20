import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { changelogPath, output, tag } = parseOptions(process.argv.slice(2));
const changelog = await readFile(resolve(changelogPath ?? resolve(repositoryRoot, "CHANGELOG.md")), "utf8");
const notes = renderReleaseNotes(changelog, tag);

if (output) {
  await writeFile(resolve(output), notes, "utf8");
} else {
  process.stdout.write(notes);
}

export function renderReleaseNotes(changelog, tag) {
  const version = normalizeTag(tag);
  const heading = new RegExp(`^## ${escapeRegex(version)}\\s*(?:—|-)\\s*.*$`, "m");
  const match = heading.exec(changelog);
  if (!match) throw new Error(`CHANGELOG.md does not contain a release section for ${version}.`);

  const sectionStart = match.index + match[0].length;
  const nextHeading = /^##\s+/m;
  nextHeading.lastIndex = sectionStart;
  const following = changelog.slice(sectionStart).search(nextHeading);
  const sectionEnd = following < 0 ? changelog.length : sectionStart + following;
  const section = changelog.slice(sectionStart, sectionEnd).trim();
  if (!section) throw new Error(`CHANGELOG.md release section for ${version} is empty.`);

  return `CoreRobin v${version}\n\n${section}\n\n## 验证与安装\n\n- macOS 应用启用 Hardened Runtime，应用与 DMG 使用 Developer ID Application 签名；DMG 完成 Apple 公证并装订可离线验证的票据。\n- Release 附带 SHA-256 校验表、SPDX SBOM，以及校验表的 Sigstore 签名包，用于独立验证资产完整性与构建来源。\n- Windows 与 Linux 安装包目前仍是未配置平台发布签名的早期预览版本。\n`;
}

function parseOptions(args) {
  const tag = args[0];
  if (!tag) {
    throw new Error("Usage: node scripts/render-release-notes.mjs vMAJOR.MINOR.PATCH [--changelog <path>] [--output <path>]");
  }
  let changelogPath = null;
  let output = null;
  for (let index = 1; index < args.length; index += 1) {
    const option = args[index];
    const value = args[index + 1] ?? null;
    if (!value) throw new Error(`Missing value for option: ${option}`);
    if (option === "--changelog") changelogPath = value;
    else if (option === "--output") output = value;
    else throw new Error(`Unknown option: ${option}`);
    index += 1;
  }
  return { changelogPath, output, tag };
}

function normalizeTag(tag) {
  const version = tag.startsWith("v") ? tag.slice(1) : tag;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid release tag: ${tag}`);
  return version;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
