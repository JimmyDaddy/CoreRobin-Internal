/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ejectRemovableVolume, getStorageHealth } from "./api";
import { StorageExplorer } from "./components/StorageExplorer";
import i18n from "./i18n";

vi.mock("./api", () => ({
  ejectRemovableVolume: vi.fn(async () => undefined),
  getStorageHealth: vi.fn(async () => ({ sampledAtMs: 1_000, devices: [] })),
  openDiskUtility: vi.fn(async () => undefined),
}));

afterEach(() => cleanup());
beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("zh-CN");
});

describe("removable volume actions", () => {
  it("requires one confirmation, ejects in place, and refreshes once", async () => {
    const onVolumeEjected = vi.fn(async () => undefined);
    render(
      <StorageExplorer
        disk={{
          readBytesPerSecond: 0,
          writeBytesPerSecond: 0,
          volumes: [{
            name: "Backup",
            mountPoint: "/Volumes/Backup",
            totalBytes: 1_000,
            availableBytes: 400,
            removable: true,
          }],
        }}
        history={[]}
        processes={[]}
        selectedIdentity={null}
        onSelectProcess={vi.fn()}
        usageThresholds={[35, 65, 85]}
        onOpenCleanup={vi.fn()}
        onVolumeEjected={onVolumeEjected}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "推出" }));
    expect(ejectRemovableVolume).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认推出" }));

    await waitFor(() =>
      expect(ejectRemovableVolume).toHaveBeenCalledWith("/Volumes/Backup"),
    );
    expect(onVolumeEjected).toHaveBeenCalledOnce();
    expect(await screen.findByText("已安全推出 Backup。")).toBeTruthy();
  });

  it("keeps the successful result when the follow-up monitor refresh fails", async () => {
    const onVolumeEjected = vi.fn(async () => {
      throw new Error("refresh failed");
    });
    render(
      <StorageExplorer
        disk={{
          readBytesPerSecond: 0,
          writeBytesPerSecond: 0,
          volumes: [{
            name: "Backup",
            mountPoint: "/Volumes/Backup",
            totalBytes: 1_000,
            availableBytes: 400,
            removable: true,
          }],
        }}
        history={[]}
        processes={[]}
        selectedIdentity={null}
        onSelectProcess={vi.fn()}
        usageThresholds={[35, 65, 85]}
        onOpenCleanup={vi.fn()}
        onVolumeEjected={onVolumeEjected}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "推出" }));
    fireEvent.click(screen.getByRole("button", { name: "确认推出" }));

    expect(await screen.findByText("已安全推出 Backup。")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("retries only the failed volume and replaces its cached result", async () => {
    vi.mocked(getStorageHealth)
      .mockResolvedValueOnce({
        sampledAtMs: 1_000,
        devices: [{
          mountPoint: "/Volumes/Backup",
          source: null,
          filesystem: null,
          smartStatus: "unknown",
          smartLabel: null,
          readOnly: null,
          internal: null,
          solidState: null,
          purgeableBytes: null,
          inspectionError: "timed out",
          inspectedAtMs: 1_000,
          cached: false,
        }],
      })
      .mockResolvedValueOnce({
        sampledAtMs: 2_000,
        devices: [{
          mountPoint: "/Volumes/Backup",
          source: "/dev/disk4s1",
          filesystem: "APFS",
          smartStatus: "verified",
          smartLabel: "Verified",
          readOnly: false,
          internal: false,
          solidState: true,
          purgeableBytes: 100,
          inspectionError: null,
          inspectedAtMs: 2_000,
          cached: false,
        }],
      });

    render(
      <StorageExplorer
        disk={{
          readBytesPerSecond: 0,
          writeBytesPerSecond: 0,
          volumes: [{
            name: "Backup",
            mountPoint: "/Volumes/Backup",
            totalBytes: 1_000,
            availableBytes: 400,
            removable: true,
          }],
        }}
        history={[]}
        processes={[]}
        selectedIdentity={null}
        onSelectProcess={vi.fn()}
        usageThresholds={[35, 65, 85]}
        onOpenCleanup={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "重试这个卷" }));

    await waitFor(() =>
      expect(getStorageHealth).toHaveBeenLastCalledWith(
        ["/Volumes/Backup"],
        true,
      ),
    );
    expect(await screen.findByText("已验证")).toBeTruthy();
    expect(screen.queryByText("操作系统未能提供这个卷的全部详情。")).toBeNull();
  });
});
