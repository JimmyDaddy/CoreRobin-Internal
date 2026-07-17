import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const releaseWorkflow = readFileSync(".github/workflows/release.yml", "utf8");
const promoteWorkflow = readFileSync(".github/workflows/promote-release.yml", "utf8");
const tauriConfig = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
const macOSPackageVerifier = readFileSync("scripts/verify-packaged-macos.sh", "utf8");
const workflowFiles = readdirSync(".github/workflows")
  .filter((name) => /\.ya?ml$/.test(name))
  .sort()
  .map((name) => readFileSync(`.github/workflows/${name}`, "utf8"));

describe("release workflow privilege separation", () => {
  it("allows update checks only against the official public-site origin", () => {
    const csp = tauriConfig.app.security.csp;
    expect(csp).toContain("connect-src ipc: http://ipc.localhost ws://localhost:1421 https://monitor-app.corerobin.com");
    expect(csp).not.toMatch(/connect-src[^;]*https:\*/);
    expect(csp).not.toMatch(/connect-src[^;]*\*/);
  });

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

  it("stages a public draft without bypassing the real-device promotion gate", () => {
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
    expect(publish).toContain("Render release notes from changelog");
    expect(publish).toContain("--notes-file release-notes.md");
    expect(publish).toContain('--repo "$PUBLIC_RELEASE_REPOSITORY"');
    expect(publish).toContain("--draft");
    expect(publish).not.toContain("--draft=false");
    expect(publish).not.toContain("--latest");
    expect(publish).not.toContain("Update public download manifest");

    const promote = workflowJob(promoteWorkflow, "promote");
    expect(promote).toContain("name: release");
    expect(promote).toContain("secrets.PUBLIC_RELEASE_TOKEN");
    expect(promote).toContain("verify-release-smoke-evidence.mjs");
    expect(promote).toContain("cosign verify-blob");
    expect(promote).toContain("SHA256SUMS.sigstore.json");
    expect(promote).toContain("--draft=false");
    expect(promote).toContain("--latest");
    expect(promote).toContain("Update public download manifest");
    expect(promote).not.toContain("id-token: write");
  });

  it("ad-hoc signs and validates complete macOS app bundles", () => {
    const build = workflowJob(releaseWorkflow, "build");
    expect(tauriConfig.identifier).toBe("com.corerobin.monitor");
    expect(tauriConfig.bundle.macOS.signingIdentity).toBe("-");
    expect(build).not.toContain("--no-sign");
    expect(build).toContain("scripts/verify-packaged-macos.sh");
    expect(build).toContain("com.corerobin.monitor");
    expect(macOSPackageVerifier).toContain("codesign --verify --deep --strict");
    expect(macOSPackageVerifier).toContain("Signature=adhoc");
    expect(macOSPackageVerifier).toContain("hdiutil attach");
    expect(macOSPackageVerifier).toContain("lipo -archs");
  });

  it("gates production entries and every platform package before publishing", () => {
    const verify = workflowJob(releaseWorkflow, "verify");
    const build = workflowJob(releaseWorkflow, "build");
    expect(verify).toContain("pnpm verify:web-bundle");
    expect(verify).toContain("pnpm test:surface-contracts");
    expect(verify).toContain("pnpm test:performance-contracts");
    expect(verify).toContain("pnpm verify:release-tools");
    expect(build).toContain("pnpm verify:web-bundle");
    expect(build).toContain("scripts/verify-packaged-macos.sh");
    expect(build).toContain("scripts/verify-packaged-linux.sh");
    expect(build).toContain("scripts/verify-packaged-windows.ps1");
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
