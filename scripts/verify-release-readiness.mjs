import { pathToFileURL } from "node:url";

import { readProjectVersions, verifyReleaseReadiness } from "./verify-release-source.mjs";

export function verifyCurrentReleaseReadiness(repositoryRoot = process.cwd()) {
  const versions = readProjectVersions(repositoryRoot);
  const expectedVersion = versions["package.json"];
  return verifyReleaseReadiness(expectedVersion, repositoryRoot);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const result = verifyCurrentReleaseReadiness();
    console.log(`Release readiness verified for ${result.expectedVersion}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
