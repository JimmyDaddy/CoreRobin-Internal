import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const releaseWorkflow = readFileSync(".github/workflows/release.yml", "utf8");
const workflowFiles = readdirSync(".github/workflows")
  .filter((name) => /\.ya?ml$/.test(name))
  .sort()
  .map((name) => readFileSync(`.github/workflows/${name}`, "utf8"));

describe("release workflow privilege separation", () => {
  it("pins every third-party action to a full commit SHA", () => {
    const actionReferences = workflowFiles.flatMap((workflow) =>
      [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)/gm)].map((match) => match[1]),
    );
    expect(actionReferences.length).toBeGreaterThan(0);
    for (const reference of actionReferences) {
      expect(reference).toMatch(/^[^@\s]+@[0-9a-f]{40}$/);
    }
  });

  it("keeps repository write permission and the public release token out of build jobs", () => {
    for (const jobName of ["verify", "build", "package", "sign"]) {
      const job = workflowJob(releaseWorkflow, jobName);
      expect(job).not.toContain("contents: write");
      expect(job).not.toContain("secrets.GITHUB_TOKEN");
      expect(job).not.toContain("secrets.PUBLIC_RELEASE_TOKEN");
    }
    expect(workflowJob(releaseWorkflow, "verify")).toContain("contents: read");
    expect(workflowJob(releaseWorkflow, "build")).toContain("contents: read");
  });

  it("uses OIDC only in the signing job", () => {
    const sign = workflowJob(releaseWorkflow, "sign");
    expect(sign).toContain("id-token: write");
    expect(sign).toContain("cosign sign-blob");
    expect(sign).toContain("cosign verify-blob");
    expect(sign).toContain("SHA256SUMS.sigstore.json");
    expect(workflowJob(releaseWorkflow, "publish")).not.toContain("id-token: write");
  });

  it("keeps the cross-repository credential in the protected publish job", () => {
    const publish = workflowJob(releaseWorkflow, "publish");
    expect(publish).toContain("name: release");
    expect(publish).toContain("contents: read");
    expect(publish).not.toContain("contents: write");
    expect(publish).toContain("secrets.PUBLIC_RELEASE_TOKEN");
    expect(publish).not.toContain("secrets.GITHUB_TOKEN");
    expect(releaseWorkflow).toContain(
      "PUBLIC_RELEASE_REPOSITORY: JimmyDaddy/corerobin-monitor",
    );
    expect(publish).toContain("sha256sum --check");
    expect(publish).toContain("cosign verify-blob");
    expect(publish).toContain('--repo "$PUBLIC_RELEASE_REPOSITORY"');
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
