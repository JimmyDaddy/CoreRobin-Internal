/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useCleanupScan } from "./useCleanupScan";

const cleanupApi = vi.hoisted(() => ({
  cancelCleanupScan: vi.fn(),
  clearPersistedCleanupScan: vi.fn(),
  getCleanupScanJob: vi.fn(),
  loadCleanupScanJobResult: vi.fn(),
  loadPersistedCleanupScan: vi.fn(),
  savePersistedCleanupScan: vi.fn(),
  startCleanupScan: vi.fn(),
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
      <button type="button" onClick={() => void scan.scan()}>Start</button>
      <button type="button" onClick={() => void scan.cancel()}>Stop</button>
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
    cleanupApi.clearPersistedCleanupScan.mockReset().mockResolvedValue(undefined);
    cleanupApi.getCleanupScanJob.mockReset().mockResolvedValue(null);
    cleanupApi.loadCleanupScanJobResult.mockReset();
    cleanupApi.loadPersistedCleanupScan.mockReset().mockResolvedValue(null);
    cleanupApi.savePersistedCleanupScan.mockReset().mockResolvedValue(undefined);
    cleanupApi.startCleanupScan.mockReset().mockResolvedValue(runningJob);
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
});
