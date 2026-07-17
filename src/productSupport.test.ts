// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import { defaultAppSettings } from "./settings";
import {
  buildRedactedDiagnosticSummary,
  checkForProductUpdate,
  clearCoreRobinWebData,
  compareStableVersions,
  completeOnboarding,
  hasCompletedOnboarding,
  localizedProductPage,
  parseReleaseManifest,
} from "./productSupport";
import { getMockSnapshot } from "./mockData";

describe("product support", () => {
  it("compares stable versions and rejects malformed manifests", () => {
    expect(compareStableVersions("0.0.5", "0.0.4")).toBe(1);
    expect(compareStableVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareStableVersions("0.9.9", "1.0.0")).toBe(-1);
    expect(() => parseReleaseManifest({ schemaVersion: 1, tagName: "latest" })).toThrow(
      "update_manifest_invalid",
    );
  });

  it("reports an available release from the public manifest", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        schemaVersion: 1,
        tagName: "v9.1.0",
        name: "CoreRobin v9.1.0",
        publishedAt: "2026-07-17T00:00:00Z",
        releaseUrl: "https://github.com/JimmyDaddy/corerobin-monitor/releases/tag/v9.1.0",
      }),
    });
    await expect(checkForProductUpdate(fetcher)).resolves.toMatchObject({
      status: "available",
      latestVersion: "9.1.0",
    });
  });

  it("creates a diagnostic summary without private host or process data", () => {
    const snapshot = getMockSnapshot();
    snapshot.host.hostname = "private-mac";
    snapshot.processes[0]!.name = "Secret App";
    const summary = buildRedactedDiagnosticSummary({
      snapshot,
      settings: defaultAppSettings("en"),
      desktopRuntime: true,
    });
    expect(summary).toContain("privacy-redacted");
    expect(summary).not.toContain("private-mac");
    expect(summary).not.toContain("Secret App");
    expect(summary).toContain("Excluded: hostname, process names, file paths");
  });

  it("clears only CoreRobin and legacy WebView data", () => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem("core-robin.settings.v1", "{}");
    localStorage.setItem("status-orbit.settings.v1", "{}");
    localStorage.setItem("unrelated", "keep");
    sessionStorage.setItem("pulse.session", "remove");
    expect(clearCoreRobinWebData()).toBe(3);
    expect(localStorage.getItem("unrelated")).toBe("keep");
    expect(localStorage.getItem("core-robin.settings.v1")).toBeNull();
    expect(sessionStorage.getItem("pulse.session")).toBeNull();
  });

  it("persists onboarding completion", () => {
    localStorage.clear();
    expect(hasCompletedOnboarding()).toBe(false);
    completeOnboarding();
    expect(hasCompletedOnboarding()).toBe(true);
  });

  it("routes Chinese and other languages to fixed localized product pages", () => {
    expect(localizedProductPage("guide", "zh-CN")).toBe("guide_zh");
    expect(localizedProductPage("privacy", "zh-Hant")).toBe("privacy_zh");
    expect(localizedProductPage("releases", "en")).toBe("releases_en");
    expect(localizedProductPage("guide", "ja")).toBe("guide_en");
  });
});
