import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const BUNDLE_IDENTIFIER = "com.corerobin.monitor";
const ARCHITECTURES = {
  aarch64: {
    target: "aarch64-apple-darwin",
    expectedArch: "arm64",
  },
  x64: {
    target: "x86_64-apple-darwin",
    expectedArch: "x86_64",
  },
};

export function macOSNotarizationStateName(tag, publicArch) {
  validateTag(tag);
  validateArchitecture(publicArch);
  return `CoreRobin_${tag.slice(1)}_${publicArch}_notarization.json`;
}

export async function createMacOSNotarizationState({
  tag,
  commit,
  sourceRunId,
  target,
  publicArch,
  expectedArch,
  teamId,
  submissionId,
  assetsRoot,
  outputPath = join(assetsRoot, macOSNotarizationStateName(tag, publicArch)),
}) {
  validateIdentity({
    tag,
    commit,
    sourceRunId,
    target,
    publicArch,
    expectedArch,
    teamId,
    submissionId,
  });

  const files = await listFiles(assetsRoot);
  const selected = [
    findExactlyOne(files, (path) => path.endsWith(".dmg"), "DMG"),
    findExactlyOne(files, (path) => path.endsWith(".app.tar.gz"), "updater package"),
    findExactlyOne(files, (path) => path.endsWith(".app.tar.gz.sig"), "updater signature"),
  ];
  const assets = [];
  for (const path of selected) {
    assets.push({
      name: basename(path),
      path: relative(assetsRoot, path),
      sha256: await sha256(path),
    });
  }

  const state = {
    schemaVersion: 1,
    kind: "github-hosted-macos-notarization",
    tag,
    version: tag.slice(1),
    commit,
    sourceRunId: String(sourceRunId),
    bundleIdentifier: BUNDLE_IDENTIFIER,
    target,
    publicArch,
    expectedArch,
    teamId,
    submissionId,
    assets,
  };
  await writeFile(outputPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o644 });
  return { state, path: outputPath };
}

export async function verifyMacOSNotarizationState({
  statePath,
  tag,
  commit,
  sourceRunId,
  publicArch,
  teamId,
  assetsRoot,
}) {
  const state = JSON.parse(await readFile(statePath, "utf8"));
  validateIdentity(state);
  if (state.schemaVersion !== 1 || state.kind !== "github-hosted-macos-notarization") {
    throw new Error("Unsupported macOS notarization state.");
  }
  if (
    state.tag !== tag
    || state.version !== tag.slice(1)
    || state.commit !== commit
    || state.sourceRunId !== String(sourceRunId)
    || state.publicArch !== publicArch
    || state.teamId !== teamId
  ) {
    throw new Error("macOS notarization state does not match the requested release source.");
  }
  if (state.bundleIdentifier !== BUNDLE_IDENTIFIER || !Array.isArray(state.assets)) {
    throw new Error("macOS notarization state metadata is invalid.");
  }

  const expectedSuffixes = [".dmg", ".app.tar.gz", ".app.tar.gz.sig"];
  if (state.assets.length !== expectedSuffixes.length) {
    throw new Error("macOS notarization state does not contain the exact expected assets.");
  }
  for (const suffix of expectedSuffixes) {
    const matches = state.assets.filter((asset) => asset?.name?.endsWith(suffix));
    if (matches.length !== 1) {
      throw new Error(`macOS notarization state must contain exactly one ${suffix} asset.`);
    }
  }

  const root = resolve(assetsRoot);
  for (const asset of state.assets) {
    if (basename(asset.name) !== asset.name || !/^[0-9a-f]{64}$/.test(asset.sha256 ?? "")) {
      throw new Error(`macOS notarization asset metadata is invalid: ${asset.name ?? "unknown"}`);
    }
    const path = resolve(root, asset.path ?? "");
    if (path !== root && !path.startsWith(`${root}${sep}`)) {
      throw new Error(`macOS notarization asset escapes its root: ${asset.name}`);
    }
    if (basename(path) !== asset.name || await sha256(path) !== asset.sha256) {
      throw new Error(`macOS notarization asset checksum mismatch: ${asset.name}`);
    }
  }
  return state;
}

function validateIdentity({
  tag,
  commit,
  sourceRunId,
  target,
  publicArch,
  expectedArch,
  teamId,
  submissionId,
}) {
  validateTag(tag);
  if (!/^[0-9a-f]{40}$/.test(commit ?? "")) throw new Error(`Invalid release commit: ${commit}`);
  if (!/^\d+$/.test(String(sourceRunId ?? ""))) throw new Error(`Invalid source run ID: ${sourceRunId}`);
  const architecture = validateArchitecture(publicArch);
  if (target !== architecture.target || expectedArch !== architecture.expectedArch) {
    throw new Error(`Invalid macOS target mapping for ${publicArch}.`);
  }
  if (!/^[A-Z0-9]{10}$/.test(teamId ?? "")) throw new Error(`Invalid Apple Team ID: ${teamId}`);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(submissionId ?? "")) {
    throw new Error(`Invalid Apple notarization submission ID: ${submissionId}`);
  }
}

function validateTag(tag) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag ?? "")) throw new Error(`Invalid stable release tag: ${tag}`);
}

function validateArchitecture(publicArch) {
  const architecture = ARCHITECTURES[publicArch];
  if (!architecture) throw new Error(`Invalid public macOS architecture: ${publicArch}`);
  return architecture;
}

async function listFiles(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

function findExactlyOne(files, predicate, description) {
  const matches = files.filter(predicate);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${description}; found ${matches.length}.`);
  }
  return matches[0];
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function run() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "create" && args.length === 10) {
    const [tag, commit, sourceRunId, target, publicArch, expectedArch, teamId, submissionId, assetsRoot, outputPath] = args;
    const result = await createMacOSNotarizationState({
      tag,
      commit,
      sourceRunId,
      target,
      publicArch,
      expectedArch,
      teamId,
      submissionId,
      assetsRoot,
      outputPath,
    });
    console.log(`Created ${basename(result.path)} for Apple submission ${submissionId}.`);
    return;
  }
  if (command === "verify" && args.length === 7) {
    const [statePath, tag, commit, sourceRunId, publicArch, teamId, assetsRoot] = args;
    const state = await verifyMacOSNotarizationState({
      statePath,
      tag,
      commit,
      sourceRunId,
      publicArch,
      teamId,
      assetsRoot,
    });
    console.log(`Verified ${state.publicArch} macOS notarization state for ${tag}.`);
    return;
  }
  if (command === "get" && args.length === 2) {
    const [statePath, field] = args;
    if (!["submissionId", "publicArch", "expectedArch", "target"].includes(field)) {
      throw new Error(`Unsupported macOS notarization state field: ${field}`);
    }
    const state = JSON.parse(await readFile(statePath, "utf8"));
    const value = state[field];
    if (typeof value !== "string" || value.length === 0) throw new Error(`Missing state field: ${field}`);
    process.stdout.write(value);
    return;
  }
  throw new Error(
    "Usage: macos-notarization-state.mjs create TAG COMMIT RUN_ID TARGET PUBLIC_ARCH EXPECTED_ARCH TEAM_ID SUBMISSION_ID ASSETS_ROOT OUTPUT | verify STATE TAG COMMIT RUN_ID PUBLIC_ARCH TEAM_ID ASSETS_ROOT | get STATE FIELD",
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await run();
}
