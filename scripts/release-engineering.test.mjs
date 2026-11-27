import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const tauriConfig = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
const ci = readFileSync(".github/workflows/ci.yml", "utf8");
const release = readFileSync(".github/workflows/release.yml", "utf8");
const stableTagActivator = readFileSync("scripts/ensure-stable-release-tag.sh", "utf8");

describe("release engineering boundaries", () => {
  it("uses the final CoreRobin application identity without a migration shim", () => {
    expect(tauriConfig.identifier).toBe("com.corerobin.monitor");
    expect(JSON.stringify(tauriConfig)).not.toContain("com.timetombs.statusorbit");
  });

  it("keeps the public repository as the only product-site source", () => {
    expect(existsSync("site")).toBe(false);
    expect(existsSync("scripts/build-site.mjs")).toBe(false);
    expect(packageJson.scripts["site:build"]).toBeUndefined();
    expect(packageJson.scripts["site:dev"]).toBeUndefined();
    expect(ci).not.toContain("Product site");
    expect(release).not.toContain("pnpm site:build");
  });

  it("keeps a single consolidated release workflow and required delivery tooling", () => {
    expect(packageJson.scripts["public:sync"]).toBe("node scripts/sync-public-content.mjs");
    expect(existsSync("scripts/sync-public-content.mjs")).toBe(true);
    expect(existsSync("scripts/update-public-release-manifest.mjs")).toBe(true);
    expect(existsSync("scripts/public-release-notes.mjs")).toBe(true);
    expect(existsSync(`release-notes/v${packageJson.version}.json`)).toBe(true);
    expect(existsSync("scripts/generate-updater-manifest.mjs")).toBe(true);
    expect(existsSync("scripts/flatten-release-artifacts.mjs")).toBe(true);
    expect(existsSync("scripts/release-macos-local.sh")).toBe(true);
    expect(existsSync("scripts/local-macos-release-manifest.mjs")).toBe(true);
    expect(existsSync(".github/workflows/release.yml")).toBe(true);
    expect(existsSync(".github/workflows/release-candidate.yml")).toBe(false);
    expect(existsSync(".github/workflows/finalize-release.yml")).toBe(false);
    expect(existsSync(".github/workflows/reconcile-notarization.yml")).toBe(false);
    expect(existsSync(".github/workflows/promote-release.yml")).toBe(false);
    expect(packageJson.scripts["release:macos:local"]).toBe("bash scripts/release-macos-local.sh");
    expect(packageJson.scripts["release:updater-manifest"]).toBe("node scripts/generate-updater-manifest.mjs");
    expect(packageJson.scripts["release:flatten-artifacts"]).toBe("node scripts/flatten-release-artifacts.mjs");
  });

  it("creates immutable stable tags only inside the approved publish stage", () => {
    expect(release).toContain("workflow_dispatch:");
    expect(release).toContain('test "$GITHUB_REF" = "refs/heads/main"');
    expect(release).toContain("bash scripts/ensure-stable-release-tag.sh");
    expect(stableTagActivator).toContain("git/matching-refs/tags/$release_tag");
    expect(stableTagActivator).not.toContain("git/ref/tags/$release_tag");
    expect(stableTagActivator).toContain('-f ref="$release_ref"');
  });

  it("runs release readiness on every pull request and main push", () => {
    expect(ci).toContain("release-readiness:");
    expect(ci).toContain("node scripts/verify-release-readiness.mjs");
  });

  it("configures mandatory signed updates from the official public release", () => {
    expect(tauriConfig.bundle.createUpdaterArtifacts).toBe(true);
    expect(tauriConfig.plugins.updater.pubkey).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(tauriConfig.plugins.updater.endpoints).toEqual([
      "https://github.com/JimmyDaddy/corerobin-monitor/releases/latest/download/latest.json",
    ]);
  });
});
