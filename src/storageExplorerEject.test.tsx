/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ejectRemovableVolume } from "./api";
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
});
