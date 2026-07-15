/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CleanupSpaceMap } from "./components/CleanupSpaceMap";
import i18n from "./i18n";
import type { CleanupNode, CleanupScan } from "./types";

const cleanupApi = vi.hoisted(() => ({
  cancelCleanupDelete: vi.fn(),
  cancelCleanupSubtree: vi.fn(),
  createCleanupDeleteLease: vi.fn(),
  executeCleanupDelete: vi.fn(),
  getCleanupPathState: vi.fn(),
  getCleanupSubtree: vi.fn(),
  releaseCleanupDeleteLease: vi.fn(),
}));

vi.mock("./api", () => cleanupApi);
vi.mock("./components/CleanupSunburstCanvas", () => ({
  CleanupSunburstCanvas: () => null,
}));
vi.mock("./components/CleanupDeleteDialog", () => ({
  CleanupDeleteDialog: () => null,
}));

afterEach(() => cleanup());

beforeEach(async () => {
  Object.values(cleanupApi).forEach((mock) => mock.mockReset());
  cleanupApi.cancelCleanupSubtree.mockResolvedValue(true);
  cleanupApi.getCleanupPathState.mockResolvedValue({
    path: "/fixture",
    exists: true,
    modifiedAtMs: 1_000,
  });
  window.localStorage.clear();
  await i18n.changeLanguage("en");
});

describe("cleanup subtree cancellation", () => {
  it("sends the abandoned request ID to the backend before starting the next subtree", async () => {
    cleanupApi.getCleanupSubtree
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValueOnce(folder("second", "/fixture/second", false));
    render(
      <CleanupSpaceMap
        snapshot={snapshot()}
        snapshotStatus="current"
        onDeletionApplied={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /First folder/ }));
    await waitFor(() => expect(cleanupApi.getCleanupSubtree).toHaveBeenCalledOnce());
    const firstRequest = cleanupApi.getCleanupSubtree.mock.calls[0][0];

    fireEvent.click(screen.getByRole("button", { name: /Second folder/ }));

    await waitFor(() => {
      expect(cleanupApi.cancelCleanupSubtree).toHaveBeenCalledWith(firstRequest.requestId);
      expect(cleanupApi.getCleanupSubtree).toHaveBeenCalledTimes(2);
    });
    expect(cleanupApi.getCleanupSubtree.mock.calls[1][0].requestId).not.toBe(
      firstRequest.requestId,
    );
  });
});

function folder(id: string, path: string, hasChildren = true): CleanupNode {
  return {
    id,
    name: id === "first" ? "First folder" : "Second folder",
    path,
    sizeBytes: 1,
    logicalSizeBytes: 1,
    allocatedSizeBytes: 1,
    itemCount: 1,
    safety: "review",
    kind: "folder",
    hasChildren,
    children: [],
  };
}

function snapshot(): CleanupScan {
  return {
    sampledAtMs: 1_000,
    durationMs: 1,
    root: {
      id: "root",
      name: "Fixture",
      path: "/fixture",
      sizeBytes: 2,
      logicalSizeBytes: 2,
      allocatedSizeBytes: 2,
      itemCount: 2,
      safety: "review",
      kind: "folder",
      hasChildren: true,
      children: [folder("first", "/fixture/first"), folder("second", "/fixture/second")],
    },
    locations: [],
    largestFiles: [],
    installedApplications: [],
    applicationInventoryAvailable: false,
    scannedEntryCount: 2,
    unreadableEntryCount: 0,
    unreadablePaths: [],
    deletionAvailable: true,
  };
}
