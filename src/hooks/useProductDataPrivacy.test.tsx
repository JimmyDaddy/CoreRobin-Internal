/** @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PERSISTENT_HISTORY_STORAGE_KEY } from "../historyStore";
import { useProductDataPrivacy } from "./useProductDataPrivacy";

const nativeData = vi.hoisted(() => ({
  getSummary: vi.fn(),
  clearInventory: vi.fn(),
  invoke: vi.fn(),
  desktop: false,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: nativeData.invoke }));

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    getProductDataCacheSummary: nativeData.getSummary,
    clearApplicationInventoryCache: nativeData.clearInventory,
    isDesktopRuntime: () => nativeData.desktop,
  };
});

beforeEach(() => {
  window.localStorage.clear();
  nativeData.getSummary.mockReset();
  nativeData.clearInventory.mockReset();
  nativeData.invoke.mockReset();
  nativeData.desktop = false;
  nativeData.getSummary.mockResolvedValue({
    cleanupScan: { byteSize: 200, fileCount: 1, updatedAtMs: 200 },
    fileInsights: { byteSize: 300, fileCount: 1, updatedAtMs: 300 },
    applicationInventory: { byteSize: 400, fileCount: 2, updatedAtMs: 400 },
    applicationHistory: { byteSize: 500, fileCount: 1, updatedAtMs: 500 },
  });
  nativeData.clearInventory.mockResolvedValue(undefined);
});

describe("useProductDataPrivacy", () => {
  const inputs = () => ({
    resourceItemCount: 0, resourceUpdatedAtMs: null, resourceRetentionDays: 7,
    connectionItemCount: 0, connectionUpdatedAtMs: null, connectionRetentionDays: 7,
    networkQualityItemCount: 0, networkQualityUpdatedAtMs: null,
    cleanupItemCount: 0, cleanupUpdatedAtMs: null, fileInsightsItemCount: 0, fileInsightsUpdatedAtMs: null,
    onClearResourceHistory: vi.fn(async () => undefined), onClearConnectionHistory: vi.fn(async () => undefined),
    onClearCleanupScan: vi.fn(async () => undefined), onClearFileInsights: vi.fn(async () => undefined),
  });

  it("blocks AI preparations for the entire source clear and releases the block after a source failure", async () => {
    nativeData.desktop = true;
    const calls: string[] = [];
    nativeData.invoke.mockImplementation(async (command, args) => {
      calls.push(command);
      if (command === "ai_invalidate_source") { expect(args).toEqual({category: "applicationInventory", deleteRelated: true}); return 42; }
      expect(args).toEqual({token: 42});
    });
    nativeData.clearInventory.mockImplementation(async () => { calls.push("clear-source"); throw new Error("source locked"); });
    const {result} = renderHook(() => useProductDataPrivacy(inputs()));
    await act(async () => { expect(await result.current.clearCategory("applicationInventory", true)).toBe(false); });
    expect(calls).toEqual(["ai_invalidate_source", "clear-source", "ai_finish_source_clear"]);
    expect(result.current.receipts.applicationInventory.error).toBe("source locked");
  });

  it("does not remove source data when AI invalidation fails", async () => {
    nativeData.desktop = true;
    nativeData.invoke.mockRejectedValue(new Error("AI invalidation failed"));
    const {result} = renderHook(() => useProductDataPrivacy(inputs()));
    await act(async () => { expect(await result.current.clearCategory("applicationInventory")).toBe(false); });
    expect(nativeData.clearInventory).not.toHaveBeenCalled();
    expect(result.current.receipts.applicationInventory.status).toBe("failed");
  });

  it("reports failure rather than success if final invalidation cannot complete", async () => {
    nativeData.desktop = true;
    nativeData.invoke.mockResolvedValueOnce(42).mockRejectedValueOnce(new Error("finish failed"));
    nativeData.getSummary.mockResolvedValue({applicationInventory: {byteSize: 0, fileCount: 0, updatedAtMs: null}});
    const {result} = renderHook(() => useProductDataPrivacy(inputs()));
    await act(async () => { expect(await result.current.clearCategory("applicationInventory")).toBe(false); });
    expect(nativeData.clearInventory).toHaveBeenCalledOnce();
    expect(result.current.receipts.applicationInventory.error).toBe("finish failed");
  });

  it("reports category footprints and retains a per-category clear receipt", async () => {
    window.localStorage.setItem(PERSISTENT_HISTORY_STORAGE_KEY, "history");
    const clearResource = vi.fn(async () => undefined);
    const clearConnections = vi.fn(async () => undefined);
    const clearCleanup = vi.fn(async () => undefined);
    const clearInsights = vi.fn(async () => undefined);
    const { result } = renderHook(() => useProductDataPrivacy({
      resourceItemCount: 3,
      resourceUpdatedAtMs: 100,
      resourceRetentionDays: 7,
      connectionItemCount: 4,
      connectionUpdatedAtMs: 110,
      connectionRetentionDays: 14,
      networkQualityItemCount: 2,
      networkQualityUpdatedAtMs: 120,
      cleanupItemCount: 5,
      cleanupUpdatedAtMs: 200,
      fileInsightsItemCount: 6,
      fileInsightsUpdatedAtMs: 300,
      onClearResourceHistory: clearResource,
      onClearConnectionHistory: clearConnections,
      onClearCleanupScan: clearCleanup,
      onClearFileInsights: clearInsights,
    }));

    await waitFor(() =>
      expect(result.current.categories.applicationInventory.byteSize).toBe(400)
    );
    expect(result.current.categories.resourceHistory).toMatchObject({
      byteSize: 507,
      itemCount: 3,
      updatedAtMs: 500,
      retentionDays: 7,
    });
    expect(result.current.categories.connectionHistory).toMatchObject({
      itemCount: 6,
      updatedAtMs: 120,
    });
    expect(result.current.categories.scanCaches).toMatchObject({
      byteSize: 500,
      itemCount: 11,
      updatedAtMs: 300,
    });

    nativeData.getSummary.mockResolvedValueOnce({
      cleanupScan: { byteSize: 0, fileCount: 0, updatedAtMs: null },
      fileInsights: { byteSize: 0, fileCount: 0, updatedAtMs: null },
      applicationInventory: { byteSize: 400, fileCount: 2, updatedAtMs: 400 },
      applicationHistory: { byteSize: 500, fileCount: 1, updatedAtMs: 500 },
      historySegments: { byteSize: 0, fileCount: 0, updatedAtMs: null },
    });
    await act(async () => {
      expect(await result.current.clearCategory("scanCaches")).toBe(true);
    });
    expect(clearCleanup).toHaveBeenCalledOnce();
    expect(clearInsights).toHaveBeenCalledOnce();
    expect(result.current.receipts.scanCaches.status).toBe("succeeded");

    nativeData.getSummary.mockResolvedValueOnce({
      cleanupScan: { byteSize: 200, fileCount: 1, updatedAtMs: 200 },
      fileInsights: { byteSize: 0, fileCount: 0, updatedAtMs: null },
      applicationInventory: { byteSize: 400, fileCount: 2, updatedAtMs: 400 },
      applicationHistory: { byteSize: 500, fileCount: 1, updatedAtMs: 500 },
      historySegments: { byteSize: 0, fileCount: 0, updatedAtMs: null },
    });
    await act(async () => {
      expect(await result.current.clearCategory("scanCaches")).toBe(false);
    });
    expect(result.current.receipts.scanCaches).toMatchObject({
      status: "failed",
      error: "product_data_clear_not_verified:scanCaches",
    });

    nativeData.clearInventory.mockRejectedValueOnce(new Error("locked"));
    await act(async () => {
      expect(await result.current.clearCategory("applicationInventory")).toBe(false);
    });
    expect(result.current.receipts.applicationInventory).toMatchObject({
      status: "failed",
      error: "locked",
    });
  });
});
