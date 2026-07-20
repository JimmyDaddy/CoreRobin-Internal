/** @vitest-environment jsdom */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApplicationUninstallAssistant } from "./components/ApplicationUninstallAssistant";
import i18n from "./i18n";
import type { ApplicationInventorySnapshot } from "./types";

const uninstallApi = vi.hoisted(() => ({
  cancelCleanupDelete: vi.fn(),
  createCleanupDeleteLease: vi.fn(),
  executeCleanupDelete: vi.fn(),
  getApplicationIcon: vi.fn(),
  getApplicationUninstallPlan: vi.fn(),
  getInstalledApplications: vi.fn(),
  releaseCleanupDeleteLease: vi.fn(),
  revealPath: vi.fn(),
}));

vi.mock("./api", () => uninstallApi);
vi.mock("./components/CleanupDeleteDialog", () => ({
  CleanupDeleteDialog: () => null,
}));

afterEach(() => cleanup());

beforeEach(async () => {
  Object.values(uninstallApi).forEach((mock) => mock.mockReset());
  uninstallApi.getApplicationIcon.mockResolvedValue(null);
  await i18n.changeLanguage("zh-CN");
});

describe("application uninstall assistant", () => {
  it("shows the application indexing stage until the initial inventory is ready", async () => {
    let resolveInventory: ((snapshot: ApplicationInventorySnapshot) => void) | undefined;
    uninstallApi.getInstalledApplications.mockImplementation(() => new Promise((resolve) => {
      resolveInventory = resolve;
    }));

    const view = render(<ApplicationUninstallAssistant />);

    expect(screen.getByRole("status").textContent).toContain("正在读取应用清单");
    expect(view.container.querySelector(".application-uninstall__scan-visual")).not.toBeNull();
    expect(view.container.querySelectorAll(".application-uninstall__scan-skeleton > span")).toHaveLength(3);

    resolveInventory?.({
      sampledAtMs: 1_000,
      platformSupported: true,
      cached: false,
      refreshRecommended: false,
      applications: [{
        name: "Example",
        path: "/Applications/Example.app",
        bundleId: "com.example.app",
        sizeBytes: 4_096,
        lastUsedAtMs: null,
        modifiedAtMs: 900,
        uninstallable: true,
        unavailableReason: null,
      }],
    });

    await waitFor(() => expect(screen.getByRole("button", { name: /Example/ })).toBeTruthy());
    expect(uninstallApi.getInstalledApplications).toHaveBeenCalledWith("zh-CN", false);
    expect(view.container.querySelector(".application-uninstall__scan-stage")).toBeNull();
  });

  it("shows a stale cache immediately and refreshes it in the background", async () => {
    const cached: ApplicationInventorySnapshot = {
      sampledAtMs: 1_000,
      platformSupported: true,
      cached: true,
      refreshRecommended: true,
      applications: [{
        name: "Cached App",
        path: "/Applications/Cached App.app",
        bundleId: "com.example.cached",
        sizeBytes: 4_096,
        lastUsedAtMs: null,
        modifiedAtMs: 900,
        uninstallable: true,
        unavailableReason: null,
      }],
    };
    uninstallApi.getInstalledApplications
      .mockResolvedValueOnce(cached)
      .mockResolvedValueOnce({
        ...cached,
        sampledAtMs: 2_000,
        cached: false,
        refreshRecommended: false,
      });

    render(<ApplicationUninstallAssistant />);

    expect(await screen.findByRole("button", { name: /Cached App/ })).toBeTruthy();
    await waitFor(() => expect(uninstallApi.getInstalledApplications).toHaveBeenCalledTimes(2));
    expect(uninstallApi.getInstalledApplications).toHaveBeenNthCalledWith(1, "zh-CN", false);
    expect(uninstallApi.getInstalledApplications).toHaveBeenNthCalledWith(2, "zh-CN", true);
  });
});
