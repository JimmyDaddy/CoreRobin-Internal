import {
  buildPublicReleaseManifest,
  readPublicReleaseNote,
} from "./public-release-notes.mjs";

const [tag, repository, ...options] = process.argv.slice(2);
if (!tag || !repository) {
  throw new Error("Usage: node scripts/update-public-release-manifest.mjs vMAJOR.MINOR.PATCH OWNER/REPOSITORY [--check]");
}
if (options.some((option) => option !== "--check")) throw new Error(`Unknown option: ${options.join(" ")}`);
const checkOnly = options.includes("--check");
if (!process.env.GH_TOKEN) {
  throw new Error("GH_TOKEN is required to update the public release manifest.");
}

const release = await releaseByTag(repository, tag);
const path = "site/release-manifest.json";
const existing = await githubJson(`/repos/${repository}/contents/${path}`).catch((error) => {
  if (error.status === 404) return null;
  throw error;
});
if (!existing?.content || existing.encoding !== "base64") {
  throw new Error(`Public website is missing ${path}.`);
}
const currentManifest = JSON.parse(Buffer.from(existing.content, "base64").toString("utf8"));
const releaseNote = readPublicReleaseNote(tag);
const manifest = `${JSON.stringify(buildPublicReleaseManifest(release, currentManifest, releaseNote), null, 2)}\n`;

if (checkOnly) {
  console.log(`Validated website release data for ${tag}; no public files changed.`);
  process.exit(0);
}

await githubJson(`/repos/${repository}/contents/${path}`, {
  method: "PUT",
  body: {
    message: `chore(release): publish website data for ${tag}`,
    content: Buffer.from(manifest).toString("base64"),
    branch: "main",
    sha: existing.sha,
  },
});

console.log(`Published download data and release notes to ${repository}/${path} for ${tag}.`);

async function releaseByTag(repository, tag) {
  try {
    return await githubJson(`/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`);
  } catch (error) {
    if (error.status !== 404) throw error;
    const releases = await githubJson(`/repos/${repository}/releases?per_page=100`);
    const release = releases.find((candidate) => candidate.tag_name === tag);
    if (!release) {
      throw new Error(`Public repository does not contain a release or draft for ${tag}.`, { cause: error });
    }
    return release;
  }
}

async function githubJson(pathname, options = {}) {
  const response = await fetch(`https://api.github.com${pathname}`, {
    method: options.method ?? "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  if (!response.ok) {
    const error = new Error(`GitHub API ${response.status} for ${pathname}: ${await response.text()}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}
