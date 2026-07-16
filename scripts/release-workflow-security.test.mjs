import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const releaseWorkflow = readFileSync(".github/workflows/release.yml", "utf8");
const workflowFiles = ["ci.yml", "pages.yml", "release.yml"].map((name) =>
  readFileSync(`.github/workflows/${name}`, "utf8"),
);

describe("release workflow privilege separation", () => {
  it("pins every third-party action to a full commit SHA", () => {
    const actionReferences = workflowFiles.flatMap((workflow) =>
      [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)/gm)].map((match) => match[1]),
    );
    const thirdPartyReferences = actionReferences.filter(
      (reference) => !reference.startsWith("./"),
    );
    expect(thirdPartyReferences.length).toBeGreaterThan(0);
    for (const reference of thirdPartyReferences) {
      expect(reference).toMatch(/^[^@\s]+@[0-9a-f]{40}$/);
    }
  });

  it("keeps local action references inside the repository actions directory", () => {
    const localReferences = workflowFiles.flatMap((workflow) =>
      [...workflow.matchAll(/^\s*uses:\s*(\.\/[^\s#]+)/gm)].map((match) => match[1]),
    );
    for (const reference of localReferences) {
      expect(reference).toMatch(/^\.\/\.github\/actions\/[a-z0-9][a-z0-9/_-]*$/);
    }
  });

  it("keeps repository write permission and the release token out of build jobs", () => {
    for (const jobName of ["verify", "build", "package", "provenance"]) {
      const job = workflowJob(releaseWorkflow, jobName);
      expect(job).not.toContain("contents: write");
      expect(job).not.toContain("secrets.GITHUB_TOKEN");
    }
    expect(workflowJob(releaseWorkflow, "verify")).toContain("contents: read");
    expect(workflowJob(releaseWorkflow, "build")).toContain("contents: read");
  });

  it("grants write permission only to the protected publish job", () => {
    const publish = workflowJob(releaseWorkflow, "publish");
    expect(publish).toContain("name: release");
    expect(publish).toContain("contents: write");
    expect(publish).toContain("secrets.GITHUB_TOKEN");
    expect(publish).toContain("sha256sum --check");
    expect(publish).toContain("gh attestation verify");
  });
});

function workflowJob(workflow, name) {
  const heading = `  ${name}:\n`;
  const start = workflow.indexOf(heading);
  if (start < 0) throw new Error(`Workflow job not found: ${name}`);
  const bodyStart = start + heading.length;
  const nextJobOffset = workflow.slice(bodyStart).search(/^ {2}[a-z][a-z0-9_-]*:\n/m);
  const end = nextJobOffset < 0 ? workflow.length : bodyStart + nextJobOffset;
  return workflow.slice(start, end);
}
