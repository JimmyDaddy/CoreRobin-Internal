/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useCleanupScan } from "./useCleanupScan";

const cleanupApi = vi.hoisted(() => ({
  cancelCleanupScan: vi.fn(),
  clearPersistedCleanupScan: vi.fn(),
  getCleanupScan: vi.fn(),
  loadPersistedCleanupScan: vi.fn(),
  savePersistedCleanupScan: vi.fn(),
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
    <button type="button" onClick={() => void scan.scan()}>
      Start
    </button>
  );
}

describe("cleanup scan lifecycle", () => {
  beforeEach(() => {
    cleanupApi.cancelCleanupScan.mockReset().mockResolvedValue(true);
    cleanupApi.clearPersistedCleanupScan.mockReset().mockResolvedValue(undefined);
    cleanupApi.getCleanupScan.mockReset().mockImplementation(
      () => new Promise(() => undefined),
    );
    cleanupApi.loadPersistedCleanupScan.mockReset().mockResolvedValue(null);
    cleanupApi.savePersistedCleanupScan.mockReset().mockResolvedValue(undefined);
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("cancels the native worker when reload abandons an active scan", async () => {
    const view = render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(cleanupApi.getCleanupScan).toHaveBeenCalledOnce());

    window.dispatchEvent(new Event("pagehide"));

    await waitFor(() => expect(cleanupApi.cancelCleanupScan).toHaveBeenCalledOnce());
    view.unmount();
  });
});
