/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ApplicationInventorySnapshot } from "./types";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class MockChannel {},
  invoke: invokeMock,
}));

function inventory(sampledAtMs: number): ApplicationInventorySnapshot {
  return {
    sampledAtMs,
    platformSupported: true,
    cached: false,
    refreshRecommended: false,
    applications: [{
      name: "Example",
      path: "/Applications/Example.app",
      bundleId: "com.example.app",
      sizeBytes: 4_096,
      lastUsedAtMs: null,
      modifiedAtMs: sampledAtMs,
      uninstallable: true,
      unavailableReason: null,
      installationSource: "macos_bundle",
      nativeUninstallIdentifier: null,
      nativeUninstallRequiresElevation: false,
      iconPath: null,
    }],
  };
}

beforeEach(() => {
  vi.resetModules();
  invokeMock.mockReset();
  window.__TAURI_INTERNALS__ = {};
});

describe("application inventory memory cache", () => {
  it("reuses a recent language-specific result and lets explicit refresh bypass it", async () => {
    invokeMock
      .mockResolvedValueOnce(inventory(1_000))
      .mockResolvedValueOnce(inventory(2_000));
    const { getInstalledApplications } = await import("./api");

    const first = await getInstalledApplications("zh-CN");
    const cached = await getInstalledApplications("zh-CN");
    const refreshed = await getInstalledApplications("zh-CN", true);

    expect(first.cached).toBe(false);
    expect(cached.cached).toBe(true);
    expect(refreshed.sampledAtMs).toBe(2_000);
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock).toHaveBeenNthCalledWith(1, "get_installed_applications", {
      language: "zh-CN",
      forceRefresh: false,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "get_installed_applications", {
      language: "zh-CN",
      forceRefresh: true,
    });
  });

  it("coalesces concurrent opens into one inventory request", async () => {
    let resolveInventory: ((snapshot: ApplicationInventorySnapshot) => void) | undefined;
    invokeMock.mockImplementation(() => new Promise((resolve) => {
      resolveInventory = resolve;
    }));
    const { getInstalledApplications } = await import("./api");

    const first = getInstalledApplications("en");
    const second = getInstalledApplications("en");
    resolveInventory?.(inventory(3_000));

    await expect(first).resolves.toMatchObject({ sampledAtMs: 3_000 });
    await expect(second).resolves.toMatchObject({ sampledAtMs: 3_000 });
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});
