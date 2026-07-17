import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const tauriConfig = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
const ci = readFileSync(".github/workflows/ci.yml", "utf8");
const release = readFileSync(".github/workflows/release.yml", "utf8");

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
  });
});
