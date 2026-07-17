import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { output, tag } = parseOptions(process.argv.slice(2));
const changelog = await readFile(resolve(repositoryRoot, "CHANGELOG.md"), "utf8");
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

  return `CoreRobin v${version}\n\n${section}\n\n## 验证与安装\n\n- Release 附带 SHA-256 校验表、SPDX SBOM，以及校验表的 Sigstore 签名包。\n- 这些来源完整性记录不能替代 Developer ID、Apple 公证或 Windows 平台签名。\n- macOS 安装包尚未经过 Apple 公证；Windows 与 Linux 安装包目前是早期预览版本。\n`;
}

function parseOptions(args) {
  const tag = args[0];
  if (!tag) throw new Error("Usage: node scripts/render-release-notes.mjs vMAJOR.MINOR.PATCH [--output <path>]");
  let output = null;
  for (let index = 1; index < args.length; index += 1) {
    if (args[index] !== "--output") throw new Error(`Unknown option: ${args[index]}`);
    output = args[index + 1] ?? null;
    index += 1;
  }
  return { tag, output };
}

function normalizeTag(tag) {
  const version = tag.startsWith("v") ? tag.slice(1) : tag;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid release tag: ${tag}`);
  return version;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
