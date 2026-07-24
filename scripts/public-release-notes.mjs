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

function assertLocalizedText(value, label, tag) {
  for (const locale of ["zh-CN", "en"]) {
    if (!String(value?.[locale] ?? "").trim()) {
      throw new Error(`Public release note ${label} requires ${locale}: ${tag}.`);
    }
  }
}
