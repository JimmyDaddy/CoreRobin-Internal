import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  readPublicReleaseNote,
  renderPublicReleaseNotes,
} from "./public-release-notes.mjs";

export function renderReleaseNotes(note) {
  return `${renderPublicReleaseNotes(note)}

## 验证与安装 / Verification and installation

- macOS 应用启用 Hardened Runtime，应用与 DMG 使用 Developer ID Application 签名；DMG 完成 Apple 公证并装订可离线验证的票据。
- Release 附带 SHA-256 校验表、SPDX SBOM，以及校验表的 Sigstore 签名包，用于独立验证资产完整性与构建来源。
- Windows 与 Linux 安装包目前仍是未配置平台发布签名的早期预览版本。
`;
}

function parseOptions(args) {
  const tag = args[0];
  if (!tag) {
    throw new Error(
      "Usage: node scripts/render-release-notes.mjs vMAJOR.MINOR.PATCH [--release-root <path>] [--output <path>]",
    );
  }
  let releaseRoot = null;
  let output = null;
  for (let index = 1; index < args.length; index += 1) {
    const option = args[index];
    const value = args[index + 1] ?? null;
    if (!value) throw new Error(`Missing value for option: ${option}`);
    if (option === "--release-root") releaseRoot = value;
    else if (option === "--output") output = value;
    else throw new Error(`Unknown option: ${option}`);
    index += 1;
  }
  return { output, releaseRoot, tag };
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const { output, releaseRoot, tag } = parseOptions(process.argv.slice(2));
  const note = readPublicReleaseNote(tag, resolve(releaseRoot ?? process.cwd()));
  const notes = renderReleaseNotes(note);
  if (output) {
    await writeFile(resolve(output), notes, "utf8");
  } else {
    process.stdout.write(notes);
  }
}
