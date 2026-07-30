import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildReleaseManifest } from "./release-manifest.mjs";

export function readPublicReleaseNote(tag, repositoryRoot = process.cwd()) {
  const path = resolve(repositoryRoot, "release-notes", `${tag}.json`);
  let note;
  try {
    note = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Missing or invalid public release note: release-notes/${tag}.json`, { cause: error });
  }
  return validatePublicReleaseNote(note, tag);
}

export function validatePublicReleaseNote(note, expectedTag) {
  if (note?.schemaVersion !== 1) throw new Error("Public release note requires schemaVersion 1.");
  if (note.tagName !== expectedTag || !/^v\d+\.\d+\.\d+$/.test(note.tagName ?? "")) {
    throw new Error(`Public release note tag ${note.tagName ?? "(missing)"} does not match ${expectedTag}.`);
  }
  assertLocalizedText(note.title, "title", expectedTag);
  if (!Array.isArray(note.items) || note.items.length === 0) {
    throw new Error(`Public release note requires at least one item: ${expectedTag}.`);
  }
  note.items.forEach((item, index) => assertLocalizedText(item, `item ${index + 1}`, expectedTag));
  assertUserFacingReleaseNote(note, expectedTag);
  return note;
}

export function buildPublicReleaseManifest(release, currentManifest, releaseNote) {
  const note = validatePublicReleaseNote(releaseNote, release?.tag_name);
  if (currentManifest?.schemaVersion !== 2 || !Array.isArray(currentManifest.releaseHistory)) {
    throw new Error("Public website must provide a schemaVersion 2 release manifest with releaseHistory.");
  }
  const publishedAt = release.published_at ?? release.created_at;
  if (Number.isNaN(Date.parse(publishedAt ?? ""))) {
    throw new Error(`Release ${release.tag_name} does not provide a valid publication date.`);
  }
  const historyEntry = {
    tagName: note.tagName,
    publishedAt,
    title: note.title,
    items: note.items,
  };
  return {
    ...buildReleaseManifest(release),
    schemaVersion: 2,
    releaseHistory: [
      historyEntry,
      ...currentManifest.releaseHistory.filter((entry) => entry.tagName !== note.tagName),
    ],
  };
}

export function renderPublicReleaseNotes(note) {
  const validated = validatePublicReleaseNote(note, note?.tagName);
  const embedded = encodeURIComponent(JSON.stringify(validated));
  return `CoreRobin ${validated.tagName}

<!-- corerobin-release-note:${embedded} -->

## ${validated.title["zh-CN"]}

${validated.items.map((item) => `- ${item["zh-CN"]}`).join("\n")}

## ${validated.title.en}

${validated.items.map((item) => `- ${item.en}`).join("\n")}`;
}

export function assertUserFacingText(text, locale, label, tag) {
  const forbiddenEngineeringTerms = {
    "zh-CN": /(?:\bCI\b|GitHub Actions|(?:发布|构建|自动化|公证|签名)工作流|webhook|Finalize|Dependabot|TypeScript|glib|GTK|Tauri|SBOM|Sigstore|工具链|构建缓存|单元测试|代码重构|文档同步|发布验收|公证状态|签名管线)/i,
    en: /\b(?:CI|GitHub Actions|(?:release|build|automation|notarization|signing) workflow|webhook|Finalize|Dependabot|TypeScript|glib|GTK|Tauri|SBOM|Sigstore|toolchain|build cache|unit tests?|code refactor|documentation sync|release checks?|notarization reconciliation|signing pipeline)\b/i,
  };
  const pattern = forbiddenEngineeringTerms[locale];
  if (!pattern) throw new Error(`Unsupported release-note locale: ${locale}.`);
  const match = String(text).match(pattern);
  if (match) {
    throw new Error(
      `Public release note ${label} contains engineering-only term "${match[0]}" (${locale}): ${tag}.`,
    );
  }
}

function assertLocalizedText(value, label, tag) {
  for (const locale of ["zh-CN", "en"]) {
    if (!String(value?.[locale] ?? "").trim()) {
      throw new Error(`Public release note ${label} requires ${locale}: ${tag}.`);
    }
  }
}

function assertUserFacingReleaseNote(note, tag) {
  for (const locale of ["zh-CN", "en"]) {
    const entries = [
      { label: "title", text: note.title[locale] },
      ...note.items.map((item, index) => ({
        label: `item ${index + 1}`,
        text: item[locale],
      })),
    ];
    for (const entry of entries) {
      assertUserFacingText(entry.text, locale, entry.label, tag);
    }
  }
}
