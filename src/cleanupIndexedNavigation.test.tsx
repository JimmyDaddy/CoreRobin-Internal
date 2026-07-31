/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CleanupSpaceMap } from "./components/CleanupSpaceMap";
import i18n from "./i18n";
import type { CleanupNode, CleanupScan, CleanupScanJobStatus } from "./types";

const cleanupApi = vi.hoisted(() => ({
  cancelCleanupDelete: vi.fn(),
  createCleanupDeleteLease: vi.fn(),
  executeCleanupDelete: vi.fn(),
  getCleanupIndexedChildren: vi.fn(),
  getCleanupIndexedDirectory: vi.fn(),
  getCleanupPathState: vi.fn(),
  releaseCleanupDeleteLease: vi.fn(),
  setCleanupDeleteLeaseMode: vi.fn(),
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
  cleanupApi.getCleanupPathState.mockResolvedValue({
    path: "/fixture",
    exists: true,
    modifiedAtMs: 1_000,
  });
  cleanupApi.getCleanupIndexedChildren.mockResolvedValue({
    items: [],
    nextCursor: null,
  });
  window.localStorage.clear();
  await i18n.changeLanguage("en");
});

describe("indexed cleanup navigation", () => {
  it("opens a deep folder from the native index without a filesystem loading state", async () => {
    const current = snapshot();
    const first = current.root.children[0];
    cleanupApi.getCleanupIndexedDirectory.mockResolvedValue({
      ...first,
      children: [file("index:fixture:4", "/fixture/first/file.bin")],
    });

    render(
      <CleanupSpaceMap
        snapshot={current}
        snapshotStatus="current"
        onDeletionApplied={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /First folder/ }));

    await waitFor(() => expect(cleanupApi.getCleanupIndexedDirectory).toHaveBeenCalledWith({
      scanId: "fixture",
      directoryId: first.id,
    }));
    expect(await screen.findByRole("button", { name: /Visible file/ })).toBeTruthy();
    expect(screen.queryByText("Loading this folder…")).toBeNull();
  });

  it("never expands the terminal other-items aggregate by scanning disk", async () => {
    const current = snapshot();
    current.root.children = [aggregate()];
    render(
      <CleanupSpaceMap
        snapshot={current}
        snapshotStatus="current"
        onDeletionApplied={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Smaller objects/ }));

    await Promise.resolve();
    expect(cleanupApi.getCleanupIndexedDirectory).not.toHaveBeenCalled();
  });

  it("keeps paged children navigable through the native index", async () => {
    const current = snapshot();
    current.root.children = [current.root.children[0], aggregate()];
    const paged = folder("index:fixture:5", "Paged folder", "/fixture/paged");
    cleanupApi.getCleanupIndexedChildren.mockResolvedValue({
      items: [paged],
      nextCursor: null,
    });
    cleanupApi.getCleanupIndexedDirectory.mockResolvedValue({
      ...paged,
      children: [file("index:fixture:6", "/fixture/paged/file.bin")],
    });
    render(
      <CleanupSpaceMap
        snapshot={current}
        snapshotStatus="current"
        onDeletionApplied={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Show 50 more/ }));
    const pagedButton = await screen.findByRole("button", { name: /Paged folder/ });
    expect(screen.queryByRole("button", { name: /Smaller objects/ })).toBeNull();
    fireEvent.click(pagedButton);

    await waitFor(() => expect(cleanupApi.getCleanupIndexedDirectory).toHaveBeenCalledWith({
      scanId: "fixture",
      directoryId: paged.id,
    }));
    expect(await screen.findByRole("button", { name: /Visible file/ })).toBeTruthy();
  });

  it("keeps stale data visible and starts an explicit background refresh", async () => {
    const current = snapshot();
    const first = current.root.children[0];
    first.children = [file("index:fixture:4", "/fixture/first/file.bin")];
    cleanupApi.getCleanupPathState.mockImplementation(async (path: string) => ({
      path,
      exists: true,
      modifiedAtMs: path === first.path ? 2_000 : 1_000,
    }));
    const onRefreshDirectory = vi.fn();
    render(
      <CleanupSpaceMap
        snapshot={current}
        snapshotStatus="current"
        onDeletionApplied={vi.fn()}
        onRefreshDirectory={onRefreshDirectory}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /First folder/ }));
    expect(screen.getByRole("button", { name: /Visible file/ })).toBeTruthy();
    const refresh = await screen.findByRole("button", { name: "Refresh First folder" });
    expect(cleanupApi.getCleanupIndexedDirectory).not.toHaveBeenCalled();

    fireEvent.click(refresh);
    expect(onRefreshDirectory).toHaveBeenCalledWith(first.id);
  });

  it("shows refresh progress and exposes cancellation while the old map remains usable", () => {
    const current = snapshot();
    const first = current.root.children[0];
    first.children = [file("index:fixture:4", "/fixture/first/file.bin")];
    const onCancel = vi.fn();
    render(
      <CleanupSpaceMap
        snapshot={current}
        snapshotStatus="current"
        onDeletionApplied={vi.fn()}
        directoryRefreshStatus={refreshStatus(first.id)}
        onCancelDirectoryRefresh={onCancel}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /First folder/ }));
    expect(screen.getByRole("button", { name: /Visible file/ })).toBeTruthy();
    expect(screen.getByText(/42 items checked/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});

function folder(id: string, name: string, path: string, hasChildren = true): CleanupNode {
  return {
    id,
    name,
    path,
    sizeBytes: 10,
    logicalSizeBytes: 10,
    allocatedSizeBytes: 10,
    itemCount: 1,
    safety: "review",
    kind: "folder",
    hasChildren,
    children: [],
  };
}

function file(id: string, path: string): CleanupNode {
  return {
    ...folder(id, "Visible file", path, false),
    kind: "file",
  };
}

function aggregate(): CleanupNode {
  return {
    ...folder("index:fixture:1#other-items", "Smaller objects", "", false),
    path: null,
    kind: "aggregate",
    deletionProtected: true,
    protectionReason: "aggregate",
  };
}

function snapshot(): CleanupScan {
  return {
    scanId: "fixture",
    profile: "complete",
    scopePaths: [],
    indexed: true,
    indexByteSize: 1_024,
    sampledAtMs: 1_000,
    durationMs: 1,
    root: {
      ...folder("index:fixture:1", "Fixture", "/fixture"),
      children: [
        folder("index:fixture:2", "First folder", "/fixture/first"),
        folder("index:fixture:3", "Second folder", "/fixture/second"),
      ],
    },
    locations: [],
    largestFiles: [],
    installedApplications: [],
    applicationInventoryAvailable: false,
    scannedEntryCount: 2,
    unreadableEntryCount: 0,
    unreadablePaths: [],
    deletionAvailable: true,
    targetKind: "folder",
    targetPath: "/fixture",
  };
}

function refreshStatus(directoryId: string): CleanupScanJobStatus {
  return {
    jobId: "refresh",
    generation: 1,
    phase: "scanning",
    startedAtMs: 1,
    updatedAtMs: 2,
    lastHeartbeatAtMs: 2,
    lastProgressAtMs: 2,
    progress: {
      scannedEntryCount: 42,
      discoveredBytes: 100,
      currentPath: "/fixture/first/nested",
      elapsedMs: 3_000,
    },
    target: {
      profile: "complete",
      targetKind: "folder",
      targetPath: directoryId,
    },
    resultAvailable: false,
    errorCode: null,
    errorMessage: null,
  };
}
