import { buildReleaseManifest } from "./release-manifest.mjs";

const [tag, repository] = process.argv.slice(2);
if (!tag || !repository) {
  throw new Error("Usage: node scripts/update-public-release-manifest.mjs vMAJOR.MINOR.PATCH OWNER/REPOSITORY");
}
if (!process.env.GH_TOKEN) {
  throw new Error("GH_TOKEN is required to update the public release manifest.");
}

const release = await githubJson(`/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`);
const manifest = `${JSON.stringify(buildReleaseManifest(release), null, 2)}\n`;
const path = "site/release-manifest.json";
const existing = await githubJson(`/repos/${repository}/contents/${path}`).catch((error) => {
  if (error.status === 404) return null;
  throw error;
});

await githubJson(`/repos/${repository}/contents/${path}`, {
  method: "PUT",
  body: {
    message: `chore(release): update download manifest for ${tag}`,
    content: Buffer.from(manifest).toString("base64"),
    branch: "main",
    ...(existing?.sha ? { sha: existing.sha } : {}),
  },
});

console.log(`Updated ${repository}/${path} for ${tag}.`);

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
