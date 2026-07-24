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

  it("keeps the basket visible and accepts drags from the folder list", async () => {
    const currentSnapshot = snapshot();
    currentSnapshot.root.children = [
      folder("first", "~/Downloads/first"),
      folder("second", "~/Downloads/second"),
    ];
    render(
      <CleanupSpaceMap
        snapshot={currentSnapshot}
        snapshotStatus="current"
        onDeletionApplied={vi.fn()}
      />,
    );
    const basket = document.querySelector<HTMLElement>(".cleanup-map__dropzone");
    expect(basket).not.toBeNull();
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => basket),
    });
    const folderButton = screen.getByRole("button", { name: /First folder/ });

    fireEvent.pointerDown(folderButton, { button: 0, pointerId: 9, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { pointerId: 9, clientX: 45, clientY: 45 });
    fireEvent.pointerUp(window, { pointerId: 9, clientX: 45, clientY: 45 });

    await waitFor(() => expect(folderButton.className).toContain("is-collected"));
    expect(basket?.textContent).toContain("1 items selected");
    delete (document as unknown as Record<string, unknown>).elementFromPoint;
  });

  it("shows a locked rejection effect and refuses protected folders", async () => {
    const currentSnapshot = snapshot();
    currentSnapshot.root.children = [
      folder("first", "~/Library/Preferences"),
      folder("second", "~/Downloads/second"),
    ];
    render(
      <CleanupSpaceMap
        snapshot={currentSnapshot}
        snapshotStatus="current"
        onDeletionApplied={vi.fn()}
      />,
    );
    const basket = document.querySelector<HTMLElement>(".cleanup-map__dropzone");
    expect(basket).not.toBeNull();
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => basket),
    });
    const folderButton = screen.getByRole("button", { name: /First folder/ });
    expect(folderButton.dataset.dragPolicy).toBe("protected");

    fireEvent.pointerDown(folderButton, { button: 0, pointerId: 10, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { pointerId: 10, clientX: 45, clientY: 45 });

    await waitFor(() => {
      expect(folderButton.className).toContain("is-protected-drag-source");
      expect(basket?.className).toContain("is-protected-drag");
      expect(basket?.textContent).toContain("System files and important settings are protected");
      expect(basket?.querySelector(".lucide-lock-keyhole")).not.toBeNull();
    });

    fireEvent.pointerUp(window, { pointerId: 10, clientX: 45, clientY: 45 });

    await waitFor(() => expect(basket?.className).toContain("is-blocked"));
    expect(folderButton.className).not.toContain("is-collected");
    expect(basket?.textContent).not.toContain("1 items selected");
    delete (document as unknown as Record<string, unknown>).elementFromPoint;
  });

  it("keeps the path action slot mounted while hovering between aggregate and real nodes", () => {
    const currentSnapshot = snapshot();
    currentSnapshot.root.children = [
      aggregate("smaller"),
      file("visible", "/fixture/.DS_Store"),
    ];
    render(
      <CleanupSpaceMap
        snapshot={currentSnapshot}
        snapshotStatus="current"
        onDeletionApplied={vi.fn()}
      />,
    );
    const slot = document.querySelector<HTMLElement>(".cleanup-map__path-actions-slot");
    expect(slot).not.toBeNull();

    fireEvent.mouseEnter(screen.getByRole("button", { name: /Smaller objects/ }));
    expect(document.querySelector(".cleanup-map__path-actions-slot")).toBe(slot);
    expect(slot?.className).toContain("is-empty");
    expect(slot?.querySelector(".cleanup-map__path-actions")).toBeNull();

    fireEvent.mouseEnter(screen.getByRole("button", { name: /Visible file/ }));
    expect(document.querySelector(".cleanup-map__path-actions-slot")).toBe(slot);
    expect(slot?.className).not.toContain("is-empty");
    expect(slot?.querySelector(".cleanup-map__path-actions")).not.toBeNull();
  });

  it("expands grouped smaller objects into concrete cleanable entries", async () => {
    const currentSnapshot = snapshot();
    currentSnapshot.root.path = "~/Downloads";
    currentSnapshot.root.children = [aggregate("smaller")];
    cleanupApi.getCleanupSubtree.mockResolvedValue({
      ...currentSnapshot.root,
      children: [file("expanded", "~/Downloads/expanded.bin")],
    });
    render(
      <CleanupSpaceMap
        snapshot={currentSnapshot}
        snapshotStatus="current"
        onDeletionApplied={vi.fn()}
      />,
    );

    const grouped = screen.getByRole("button", { name: /Smaller objects/ });
    expect(grouped.dataset.dragPolicy).toBe("expand");
    expect(grouped.textContent).not.toContain("Protected");
    expect(grouped.querySelector(".lucide-lock-keyhole")).toBeNull();

    fireEvent.click(grouped);

    await waitFor(() => expect(cleanupApi.getCleanupSubtree).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "~/Downloads",
        safety: "review",
        expandSmallerObjects: true,
      }),
    ));
    const concrete = await screen.findByRole("button", { name: /Visible file/ });
    expect(concrete.dataset.dragPolicy).toBe("collect");
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

function aggregate(id: string): CleanupNode {
  return {
    ...folder(id, "", true),
    name: "Smaller objects",
    path: null,
    kind: "aggregate",
    deletionProtected: false,
    protectionReason: null,
  };
}

function file(id: string, path: string): CleanupNode {
  return {
    ...folder(id, path, false),
    name: "Visible file",
    kind: "file",
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
