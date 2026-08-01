/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useCleanupScan } from "./useCleanupScan";
import type { CleanupScan } from "../types";

const cleanupApi = vi.hoisted(() => ({
  cancelCleanupScan: vi.fn(),
  clearPersistedCleanupScan: vi.fn(),
  cancelCleanupDirectoryRefresh: vi.fn(),
  getCleanupDirectoryRefreshJob: vi.fn(),
  getCleanupScanJob: vi.fn(),
  loadCleanupDirectoryRefreshResult: vi.fn(),
  loadCleanupScanJobResult: vi.fn(),
  loadPersistedCleanupScan: vi.fn(),
  savePersistedCleanupScan: vi.fn(),
  startCleanupScan: vi.fn(),
  startCleanupDirectoryRefresh: vi.fn(),
}));

vi.mock("../api", () => cleanupApi);
vi.mock("./useNativeHistoryStorage", () => ({
  useNativeHistoryStorage: () => ({
    value: [],
    setValue: vi.fn(),
    hydrated: true,
    storageStatus: {
      state: "ready",
      byteSize: 0,
      lastSavedAtMs: null,
      error: null,
    },
    clear: vi.fn(),
    persistNow: vi.fn(),
  }),
}));

function Harness() {
  const scan = useCleanupScan();
  return (
    <>
      <span>{scan.phase ?? "idle"}</span>
      <span>{scan.snapshot?.scanId ?? "no-snapshot"}</span>
      <button type="button" onClick={() => void scan.scan()}>Start</button>
      <button type="button" onClick={() => void scan.cancel()}>Stop</button>
      <button type="button" onClick={() => void scan.clear()}>Clear</button>
      <button type="button" onClick={() => void scan.reloadLatestSnapshot()}>Reload</button>
    </>
  );
}

const runningJob = {
  jobId: "cleanup-1",
  generation: 1,
  phase: "scanning" as const,
  startedAtMs: 100,
  updatedAtMs: 200,
  lastHeartbeatAtMs: 200,
  lastProgressAtMs: 200,
  progress: {
    scannedEntryCount: 640,
    discoveredBytes: 1_280_000_000,
    currentPath: "~/Downloads",
    elapsedMs: 100,
  },
  target: { targetKind: "system_disk" as const, targetPath: null },
  resultAvailable: false,
  errorCode: null,
  errorMessage: null,
};

describe("cleanup scan lifecycle", () => {
  beforeEach(() => {
    cleanupApi.cancelCleanupScan.mockReset().mockResolvedValue(true);
    cleanupApi.cancelCleanupDirectoryRefresh.mockReset().mockResolvedValue(true);
    cleanupApi.clearPersistedCleanupScan.mockReset().mockResolvedValue(undefined);
    cleanupApi.getCleanupScanJob.mockReset().mockResolvedValue(null);
    cleanupApi.getCleanupDirectoryRefreshJob.mockReset().mockResolvedValue(null);
    cleanupApi.loadCleanupScanJobResult.mockReset();
    cleanupApi.loadCleanupDirectoryRefreshResult.mockReset();
    cleanupApi.loadPersistedCleanupScan.mockReset().mockResolvedValue(null);
    cleanupApi.savePersistedCleanupScan.mockReset().mockResolvedValue(undefined);
    cleanupApi.startCleanupScan.mockReset().mockResolvedValue(runningJob);
    cleanupApi.startCleanupDirectoryRefresh.mockReset();
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("reattaches to a native scan after the WebView reloads", async () => {
    cleanupApi.getCleanupScanJob.mockResolvedValue(runningJob);
    const view = render(<Harness />);
    await waitFor(() => expect(screen.getByText("scanning")).toBeTruthy());

    view.unmount();
    expect(cleanupApi.cancelCleanupScan).not.toHaveBeenCalled();

    render(<Harness />);
    await waitFor(() => expect(screen.getByText("scanning")).toBeTruthy());
    expect(cleanupApi.getCleanupScanJob.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(cleanupApi.cancelCleanupScan).not.toHaveBeenCalled();
  });

  it("asks the native manager to cancel the active job", async () => {
    cleanupApi.getCleanupScanJob.mockResolvedValue(runningJob);
    render(<Harness />);
    await waitFor(() => expect(screen.getByText("scanning")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    await waitFor(() => expect(cleanupApi.cancelCleanupScan).toHaveBeenCalledOnce());
  });

  it("keeps an automatically recovering scan attached and cancellable", async () => {
    cleanupApi.getCleanupScanJob.mockResolvedValue({
      ...runningJob,
      phase: "stalled",
    });
    render(<Harness />);
    await waitFor(() => expect(screen.getByText("stalled")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    await waitFor(() => expect(cleanupApi.cancelCleanupScan).toHaveBeenCalledOnce());
    expect(cleanupApi.startCleanupScan).not.toHaveBeenCalled();
  });

  it("terminates both native workers before clearing the index", async () => {
    cleanupApi.getCleanupScanJob.mockResolvedValue(runningJob);
    cleanupApi.getCleanupDirectoryRefreshJob.mockResolvedValue({
      ...runningJob,
      jobId: "cleanup-refresh-1",
      target: {
        profile: "complete",
        targetKind: "folder",
        targetPath: "index:fixture:2",
      },
    });
    render(<Harness />);
    await waitFor(() => expect(screen.getByText("scanning")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));

    await waitFor(() => expect(cleanupApi.clearPersistedCleanupScan).toHaveBeenCalledOnce());
    expect(cleanupApi.cancelCleanupScan).toHaveBeenCalledOnce();
    expect(cleanupApi.cancelCleanupDirectoryRefresh).toHaveBeenCalledOnce();
  });

  it("atomically adopts a newer persisted scan generation", async () => {
    cleanupApi.loadPersistedCleanupScan
      .mockResolvedValueOnce(null)
      .mockResolvedValue(latestSnapshot());
    render(<Harness />);
    await waitFor(() => expect(screen.getByText("no-snapshot")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Reload" }));

    await waitFor(() => expect(screen.getByText("cleanup-new")).toBeTruthy());
    expect(cleanupApi.getCleanupScanJob).toHaveBeenCalled();
  });
});

function latestSnapshot(): CleanupScan {
  return {
    scanId: "cleanup-new",
    profile: "complete",
    scopePaths: [],
    indexed: true,
    indexByteSize: 1_024,
    sampledAtMs: 1_000,
    durationMs: 100,
    root: {
      id: "index:cleanup-new:1",
      name: "System disk",
      path: "/",
      sizeBytes: 1,
      logicalSizeBytes: 1,
      allocatedSizeBytes: 1,
      itemCount: 1,
      safety: "review",
      kind: "folder",
      hasChildren: false,
      children: [],
    },
    locations: [],
    largestFiles: [],
    installedApplications: [],
    applicationInventoryAvailable: false,
    scannedEntryCount: 1,
    unreadableEntryCount: 0,
    unreadablePaths: [],
    deletionAvailable: true,
    targetKind: "system_disk",
    targetPath: "/",
  };
}
