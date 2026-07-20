import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const tauriConfig = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
const ci = readFileSync(".github/workflows/ci.yml", "utf8");
const release = readFileSync(".github/workflows/release.yml", "utf8");
const releaseCandidate = readFileSync(".github/workflows/release-candidate.yml", "utf8");

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

  it("keeps public documentation sync and release-manifest delivery available", () => {
    expect(packageJson.scripts["public:sync"]).toBe("node scripts/sync-public-content.mjs");
    expect(existsSync("scripts/sync-public-content.mjs")).toBe(true);
    expect(existsSync("scripts/update-public-release-manifest.mjs")).toBe(true);
    expect(existsSync("scripts/generate-updater-manifest.mjs")).toBe(true);
    expect(existsSync("scripts/flatten-release-artifacts.mjs")).toBe(true);
    expect(existsSync("scripts/release-macos-local.sh")).toBe(true);
    expect(existsSync("scripts/local-macos-release-manifest.mjs")).toBe(true);
    expect(existsSync("scripts/macos-notarization-state.mjs")).toBe(true);
    expect(existsSync("scripts/prepare-preview-assets.mjs")).toBe(true);
    expect(existsSync("scripts/render-preview-release-notes.mjs")).toBe(true);
    expect(existsSync(".github/workflows/finalize-release.yml")).toBe(true);
    expect(existsSync(".github/workflows/release-candidate.yml")).toBe(true);
    expect(existsSync("infra/notary-webhook-relay/src/index.mjs")).toBe(true);
    expect(existsSync("infra/notary-webhook-relay/wrangler.jsonc")).toBe(true);
    expect(packageJson.scripts["relay:test"]).toContain("notary-webhook-relay.test.mjs");
    expect(packageJson.scripts["relay:deploy"]).toContain("infra/notary-webhook-relay/wrangler.jsonc");
    expect(packageJson.scripts["release:macos:local"]).toBe("bash scripts/release-macos-local.sh");
    expect(packageJson.scripts["release:updater-manifest"]).toBe("node scripts/generate-updater-manifest.mjs");
    expect(packageJson.scripts["release:flatten-artifacts"]).toBe("node scripts/flatten-release-artifacts.mjs");
  });

  it("validates candidates before creating an immutable stable tag", () => {
    expect(releaseCandidate).toContain("workflow_dispatch:");
    expect(releaseCandidate).toContain('test "$GITHUB_REF" = "refs/heads/main"');
    expect(releaseCandidate).toContain("pnpm verify:release-tools");
    expect(releaseCandidate).toContain('name: Package candidate (${{ matrix.label }})');
    expect(releaseCandidate).toContain("Build Developer ID signed candidate installer and updater");
    expect(releaseCandidate).toContain("signed-preview");
    expect(releaseCandidate).toContain("name: release");
    expect(releaseCandidate).toContain("actions: write");
    expect(releaseCandidate).toContain("contents: write");
    expect(releaseCandidate).toContain('ref="refs/tags/$release_tag"');
    expect(releaseCandidate).toContain("gh workflow run release.yml");
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
