/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  setCleanupDeleteLeaseMode: vi.fn(),
}));

vi.mock("./api", () => uninstallApi);
vi.mock("./components/CleanupDeleteDialog", () => ({
  CleanupDeleteDialog: ({
    onDeleteAcknowledgedChange,
    onConfirm,
    progressVariant,
  }: {
    onDeleteAcknowledgedChange: (checked: boolean) => void;
    onConfirm: () => void;
    progressVariant?: string;
  }) => (
    <div data-testid="delete-dialog" data-progress-variant={progressVariant}>
      <button type="button" onClick={() => onDeleteAcknowledgedChange(true)}>acknowledge removal</button>
      <button type="button" onClick={onConfirm}>confirm removal</button>
    </div>
  ),
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
        installationSource: "macos_bundle",
        nativeUninstallIdentifier: null,
        nativeUninstallRequiresElevation: false,
        iconPath: null,
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
        installationSource: "macos_bundle",
        nativeUninstallIdentifier: null,
        nativeUninstallRequiresElevation: false,
        iconPath: null,
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

  it("offers bundle-only uninstall when the app has no bundle identifier", async () => {
    const application = {
      name: "Legacy App",
      path: "/Applications/Legacy App.app",
      bundleId: null,
      sizeBytes: 8_192,
      lastUsedAtMs: null,
      modifiedAtMs: 900,
      uninstallable: true,
      unavailableReason: null,
    };
    uninstallApi.getInstalledApplications.mockResolvedValue({
      sampledAtMs: 1_000,
      platformSupported: true,
      cached: false,
      refreshRecommended: false,
      applications: [application],
    });
    uninstallApi.getApplicationUninstallPlan.mockResolvedValue({
      sampledAtMs: 1_000,
      application,
      artifacts: [{
        kind: "application",
        path: application.path,
        logicalSizeBytes: application.sizeBytes,
        allocatedSizeBytes: application.sizeBytes,
        itemCount: 2,
        required: true,
      }],
      skippedPaths: [],
    });
    uninstallApi.createCleanupDeleteLease.mockResolvedValue({
      id: "lease-bundle-only",
      mode: "trash",
      paths: [application.path],
      missingPaths: [],
      unavailablePaths: [],
      changedPaths: [],
      refreshedTargets: [{
        path: application.path,
        logicalSizeBytes: application.sizeBytes,
        allocatedSizeBytes: application.sizeBytes,
        itemCount: 2,
      }],
      executable: true,
      refreshedAtMs: 1_100,
    });

    render(<ApplicationUninstallAssistant />);

    fireEvent.click(await screen.findByRole("button", { name: /Legacy App/ }));
    expect(await screen.findByText(/只卸载经过路径与结构验证的应用本体/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /检查并卸载 Legacy App/ }));

    await waitFor(() => expect(uninstallApi.createCleanupDeleteLease).toHaveBeenCalledWith(
      expect.objectContaining({
        applicationUninstall: {
          applicationPath: application.path,
          bundleId: null,
        },
      }),
    ));
  });

  it("keeps a removed app in place with its Trash status instead of rescanning the inventory", async () => {
    const application = {
      name: "Example",
      path: "/Applications/Example.app",
      bundleId: "com.example.app",
      sizeBytes: 4_096,
      lastUsedAtMs: null,
      modifiedAtMs: 900,
      uninstallable: true,
      unavailableReason: null,
    };
    uninstallApi.getInstalledApplications.mockResolvedValue({
      sampledAtMs: 1_000,
      platformSupported: true,
      cached: false,
      refreshRecommended: false,
      applications: [application],
    });
    uninstallApi.getApplicationUninstallPlan.mockResolvedValue({
      sampledAtMs: 1_000,
      application,
      artifacts: [{
        kind: "application",
        path: application.path,
        logicalSizeBytes: application.sizeBytes,
        allocatedSizeBytes: application.sizeBytes,
        itemCount: 1,
        required: true,
      }],
      skippedPaths: [],
    });
    uninstallApi.createCleanupDeleteLease.mockResolvedValue({
      id: "lease-1",
      mode: "trash",
      paths: [application.path],
      missingPaths: [],
      unavailablePaths: [],
      changedPaths: [],
      refreshedTargets: [{
        path: application.path,
        logicalSizeBytes: application.sizeBytes,
        allocatedSizeBytes: application.sizeBytes,
        itemCount: 1,
      }],
      executable: true,
      refreshedAtMs: 1_100,
    });
    uninstallApi.executeCleanupDelete.mockResolvedValue({
      deleted: [{ path: application.path, deletedBytes: application.sizeBytes }],
      deletedBytes: application.sizeBytes,
      failed: [],
      cancelled: false,
      interruptedPath: null,
    });

    const view = render(<ApplicationUninstallAssistant />);

    fireEvent.click(await screen.findByRole("button", { name: /Example/ }));
    fireEvent.click(await screen.findByRole("button", { name: /检查并卸载 Example/ }));
    await waitFor(() => expect(uninstallApi.createCleanupDeleteLease).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("delete-dialog").getAttribute("data-progress-variant")).toBe("application");

    fireEvent.click(screen.getByRole("button", { name: "acknowledge removal" }));
    fireEvent.click(screen.getByRole("button", { name: "confirm removal" }));

    await waitFor(() => expect(uninstallApi.executeCleanupDelete).toHaveBeenCalledTimes(1));
    const removedRow = await screen.findByRole("button", { name: /Example · 已移至废纸篓/ });
    expect(removedRow.hasAttribute("disabled")).toBe(true);
    expect(screen.getAllByText("已移至废纸篓").length).toBeGreaterThan(0);
    expect(screen.getByText(/清空废纸篓前仍可恢复/)).toBeTruthy();
    expect(uninstallApi.getInstalledApplications).toHaveBeenCalledTimes(1);

    view.unmount();
    render(<ApplicationUninstallAssistant />);
    const retainedRow = await screen.findByRole("button", { name: /Example · 已移至废纸篓/ });
    expect(retainedRow.hasAttribute("disabled")).toBe(true);
    expect(uninstallApi.getInstalledApplications).toHaveBeenNthCalledWith(2, "zh-CN", false);
  });
});
