/** @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CleanupSpaceMap } from "./components/CleanupSpaceMap";
import type { CleanupMapArc, CleanupMapNode } from "./cleanupMap";
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
  CleanupSunburstCanvas: ({ arcs, onActivate, onSelect }: { arcs: CleanupMapArc[]; onActivate: (node: CleanupMapNode) => void; onSelect: (node: CleanupMapNode | null) => void }) => (
    <div>{arcs.map(({ node }) => <button key={node.id} onMouseEnter={() => onSelect(node)} onMouseLeave={() => onSelect(null)} onClick={() => onActivate(node)}>{node.kind === "aggregate" ? "Other content" : node.name}</button>)}</div>
  ),
}));
vi.mock("./components/CleanupDeleteDialog", () => ({
  CleanupDeleteDialog: () => null,
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

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
  it("defers live checkpoints while browsing and requires the current result before cleanup", async () => {
    window.localStorage.setItem("core-robin.cleanup-map-mode.v1", "category");
    const current = { ...snapshot(), partial: true, indexed: false, deletionAvailable: false };
    current.root.children = [{ ...file("file", "/Users/demo/file.bin"), deletionProtected: false, protectionReason: null }];
    const props = { snapshot: current, snapshotStatus: "updating" as const, scanActive: true, scanPhase: "scanning" as const, onDeletionApplied: vi.fn() };
    const view = render(<CleanupSpaceMap {...props} />);
    const canvas = view.container.querySelector(".cleanup-map__canvas")!;
    fireEvent.mouseEnter(canvas);
    fireEvent.mouseEnter(screen.getByRole("button", { name: "Visible file" }));
    fireEvent.click(screen.getByRole("button", { name: "Add to cleanup basket" }));
    const before = view.container.querySelector(".cleanup-map__center-control strong")?.textContent;
    const completed = { ...current, partial: false, deletionAvailable: true, root: { ...current.root, allocatedSizeBytes: current.root.allocatedSizeBytes + 4096 } };
    view.rerender(<CleanupSpaceMap {...props} snapshot={completed} scanActive={false} scanPhase="completed" />);
    expect(view.container.querySelector(".cleanup-map__center-control strong")?.textContent).toBe(before);
    expect(screen.getByRole("button", { name: "Update map" })).toBeTruthy();
    expect((view.container.querySelector(".cleanup-map__basket-review") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Update map" }));
    await waitFor(() => expect(view.container.querySelector(".cleanup-map__center-control strong")?.textContent).not.toBe(before));
    expect(view.container.querySelector(".cleanup-map__basket-copy")?.textContent).toContain("Visible file");
    expect((view.container.querySelector(".cleanup-map__basket-review") as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("button", { name: "File paths" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("refreshes the visible indexed ancestry without losing the folder or basket on completion", async () => {
    const current = { ...snapshot(), partial: true, deletionAvailable: false };
    const child = { ...file("index:fixture:4", "/Users/demo/file.bin"), deletionProtected: false, protectionReason: null };
    cleanupApi.getCleanupIndexedDirectory.mockResolvedValue({ ...current.root.children[0], children: [child] });
    const props = { snapshot: current, snapshotStatus: "updating" as const, scanActive: true, onDeletionApplied: vi.fn() };
    const view = render(<CleanupSpaceMap {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "First folder" }));
    await screen.findByRole("button", { name: "Visible file" });
    fireEvent.mouseEnter(screen.getByRole("button", { name: "Visible file" }));
    fireEvent.click(screen.getByRole("button", { name: "Add to cleanup basket" }));
    fireEvent.mouseLeave(view.container.querySelector(".cleanup-map__canvas")!);
    view.rerender(<CleanupSpaceMap {...props} scanActive={false} snapshot={{ ...current, partial: false, deletionAvailable: true, sampledAtMs: 2000, root: { ...current.root } }} />);
    await waitFor(() => expect(cleanupApi.getCleanupIndexedDirectory).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "First folder" }).getAttribute("aria-current")).toBe("page");
    expect(view.container.querySelector(".cleanup-map__basket-copy")?.textContent).toContain("Visible file");
    expect((view.container.querySelector(".cleanup-map__basket-review") as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps map selection when leaving the canvas and opens details without losing keyboard focus", () => {
    const current = snapshot();
    current.root.children = [file("file", "/fixture/file.bin")];
    render(<CleanupSpaceMap snapshot={current} snapshotStatus="current" onDeletionApplied={vi.fn()} />);
    const sector = screen.getByRole("button", { name: "Visible file" });
    fireEvent.mouseEnter(sector);
    fireEvent.mouseLeave(sector);
    const details = screen.getByRole("button", { name: "Space details" });
    fireEvent.click(details);
    const dialog = screen.getByRole("dialog", { name: "Space details" });
    expect(dialog.querySelector('[title="/fixture/file.bin"]')).not.toBeNull();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Close");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(details);
  });

  it("searches from the map and retains the selected file and basket across view switches", async () => {
    vi.useFakeTimers();
    const current = snapshot();
    current.indexed = false;
    current.root.children = [{ ...file("file", "/Users/demo/file.bin"), deletionProtected: false, protectionReason: null }];
    const { container } = render(<CleanupSpaceMap snapshot={current} snapshotStatus="current" onDeletionApplied={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByRole("button", { name: "Visible file" }));
    fireEvent.click(screen.getByRole("button", { name: "Add to cleanup basket" }));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Visible" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(container.querySelector(".cleanup-map__workspace.is-list")).not.toBeNull();
    expect(screen.getByRole("checkbox").getAttribute("aria-label")).toContain("Remove from cleanup basket");
    fireEvent.click(screen.getByRole("button", { name: "Space map" }));
    expect(container.querySelector(".cleanup-map__selection")?.textContent).toContain("Visible file");
    expect(container.querySelector(".cleanup-map__basket-copy")?.textContent).toContain("Visible file");
    expect(screen.getByRole("button", { name: "Remove from cleanup basket" })).toBeTruthy();
  });

  it("returns through browsing history after entering a directory", () => {
    const current = snapshot();
    current.root.children[0].children = [file("file", "/fixture/first/file.bin")];
    render(<CleanupSpaceMap snapshot={current} snapshotStatus="current" onDeletionApplied={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "First folder" }));
    expect(screen.getByRole("button", { name: "Back" }).hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("button", { name: "Fixture" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: "Back" }).hasAttribute("disabled")).toBe(true);
  });

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

    fireEvent.click(screen.getByRole("button", { name: /Other content/ }));

    await Promise.resolve();
    expect(cleanupApi.getCleanupIndexedDirectory).not.toHaveBeenCalled();
  });

  it("never turns an aggregate into an implicit directory refresh", async () => {
    const current = snapshot();
    current.root.children = [deferredAggregate()];
    const onRefreshDirectory = vi.fn();
    render(
      <CleanupSpaceMap
        snapshot={current}
        snapshotStatus="current"
        onDeletionApplied={vi.fn()}
        onRefreshDirectory={onRefreshDirectory}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Other content/ }));

    await Promise.resolve();
    expect(onRefreshDirectory).not.toHaveBeenCalled();
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

    fireEvent.click(screen.getByRole("button", { name: "List" }));
    const pagedButton = await screen.findByRole("button", { name: "Open Paged folder" });
    fireEvent.click(pagedButton);

    await waitFor(() => expect(cleanupApi.getCleanupIndexedDirectory).toHaveBeenCalledWith({
      scanId: "fixture",
      directoryId: paged.id,
    }));
    fireEvent.click(screen.getByRole("button", { name: "Space map" }));
    expect(await screen.findByRole("button", { name: /Visible file/ })).toBeTruthy();
  });

  it("offers a paged searchable list backed by the scan index", async () => {
    const current = snapshot();
    const indexed = folder("index:fixture:8", "Large Cache", "/fixture/cache");
    cleanupApi.getCleanupIndexedChildren.mockResolvedValue({
      items: [indexed],
      nextCursor: 60,
    });
    render(
      <CleanupSpaceMap
        snapshot={current}
        snapshotStatus="current"
        onDeletionApplied={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "List" }));
    await waitFor(() => expect(cleanupApi.getCleanupIndexedChildren).toHaveBeenCalledWith({
      scanId: "fixture",
      directoryId: current.root.id,
      cursor: null,
      limit: 60,
      query: null,
      sortBy: "size",
      descending: true,
    }));
    expect(await screen.findByText("Large Cache")).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText("Search this folder"), {
      target: { value: "cache" },
    });
    await waitFor(() => expect(cleanupApi.getCleanupIndexedChildren).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: "cache" }),
    ));
  });

  it("selects a list row before opening the folder with its explicit action", async () => {
    const current = snapshot();
    const indexed = folder("index:fixture:8", "Large Cache", "/fixture/cache");
    const nested = file("index:fixture:9", "/fixture/cache/file.bin");
    cleanupApi.getCleanupIndexedChildren.mockImplementation(
      async ({ directoryId }: { directoryId: string }) => ({
        items: directoryId === current.root.id ? [indexed] : [nested],
        nextCursor: null,
      }),
    );
    cleanupApi.getCleanupIndexedDirectory.mockResolvedValue({
      ...indexed,
      children: [nested],
    });

    const { container } = render(
      <CleanupSpaceMap
        snapshot={current}
        snapshotStatus="current"
        onDeletionApplied={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "List" }));
    const row = await screen.findByRole("button", { name: /^Large Cache/ });
    fireEvent.click(row);
    expect(cleanupApi.getCleanupIndexedDirectory).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open Large Cache" }));

    await waitFor(() => expect(cleanupApi.getCleanupIndexedDirectory).toHaveBeenCalledWith({
      scanId: "fixture",
      directoryId: indexed.id,
    }));
    expect(container.querySelector(".cleanup-map__workspace.is-list")).not.toBeNull();
    expect(await screen.findByRole("button", { name: /Visible file/ })).toBeTruthy();
  });

  it("keeps an indexed list settled across renders instead of repeatedly reloading", async () => {
    vi.useFakeTimers();
    const current = snapshot();
    const indexed = file("index:fixture:8", "/fixture/file.bin");
    cleanupApi.getCleanupIndexedChildren.mockImplementation(async () => ({
      items: [{ ...indexed }],
      nextCursor: null,
    }));
    const { container, rerender } = render(
      <CleanupSpaceMap snapshot={current} snapshotStatus="current" onDeletionApplied={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "List" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    fireEvent.click(screen.getByRole("button", { name: /Visible file/ }));
    rerender(
      <CleanupSpaceMap snapshot={{ ...current, root: { ...current.root } }} snapshotStatus="current" onDeletionApplied={vi.fn()} />,
    );
    for (let frame = 0; frame < 5; frame += 1) {
      await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    }

    expect(cleanupApi.getCleanupIndexedChildren).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll('[role="listitem"]')).toHaveLength(1);
    expect(screen.queryByText("Reading the index…")).toBeNull();
  });

  it("does not append an old directory page after navigating into a folder", async () => {
    vi.useFakeTimers();
    const current = snapshot();
    const nested = file("index:fixture:9", "/fixture/cache/current.bin");
    const indexed = { ...folder("index:fixture:8", "Large Cache", "/fixture/cache"), children: [nested] };
    const oldPage = deferred<{ items: CleanupNode[]; nextCursor: number | null }>();
    cleanupApi.getCleanupIndexedChildren.mockImplementation(
      async ({ directoryId, cursor }: { directoryId: string; cursor: number | null }) => {
        if (cursor !== null) return oldPage.promise;
        return { items: directoryId === current.root.id ? [indexed] : [nested], nextCursor: directoryId === current.root.id ? 60 : null };
      },
    );
    const { container } = render(
      <CleanupSpaceMap snapshot={current} snapshotStatus="current" onDeletionApplied={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "List" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Large Cache" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    await act(async () => { oldPage.resolve({ items: [file("index:fixture:10", "/fixture/old-page.bin")], nextCursor: 120 }); });

    expect(container.querySelectorAll('[role="listitem"]')).toHaveLength(1);
    expect(screen.getByRole("button", { name: /Visible file/ }).getAttribute("title")).toBe(nested.path);
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    expect(screen.queryByText("Reading the index…")).toBeNull();
  });

  it("keeps loaded rows available when pagination fails and retries that page", async () => {
    vi.useFakeTimers();
    cleanupApi.getCleanupIndexedChildren
      .mockResolvedValueOnce({ items: [file("index:fixture:8", "/fixture/first.bin")], nextCursor: 60 })
      .mockRejectedValueOnce(new Error("Index temporarily unavailable"))
      .mockResolvedValueOnce({ items: [file("index:fixture:9", "/fixture/second.bin")], nextCursor: null });
    const { container } = render(
      <CleanupSpaceMap snapshot={snapshot()} snapshotStatus="current" onDeletionApplied={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "List" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Load more" })); });
    expect(container.querySelectorAll('[role="listitem"]')).toHaveLength(1);
    expect(screen.getByRole("alert").textContent).toContain("Could not load the list");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Retry" })); });

    expect(cleanupApi.getCleanupIndexedChildren).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 60 }));
    expect(container.querySelectorAll('[role="listitem"]')).toHaveLength(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("retries an initial index failure without changing the query", async () => {
    vi.useFakeTimers();
    cleanupApi.getCleanupIndexedChildren
      .mockRejectedValueOnce(new Error("Index temporarily unavailable"))
      .mockResolvedValueOnce({ items: [file("index:fixture:8", "/fixture/file.bin")], nextCursor: null });
    render(<CleanupSpaceMap snapshot={snapshot()} snapshotStatus="current" onDeletionApplied={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "List" }));
    expect(screen.queryByText("No matching items in this folder")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });

    expect(screen.getByRole("button", { name: /Visible file/ })).toBeTruthy();
    expect(cleanupApi.getCleanupIndexedChildren).toHaveBeenCalledTimes(2);
  });

  it("reloads the list when the same scan receives a refreshed index snapshot", async () => {
    vi.useFakeTimers();
    const current = snapshot();
    const { rerender } = render(
      <CleanupSpaceMap snapshot={current} snapshotStatus="current" onDeletionApplied={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    cleanupApi.getCleanupIndexedChildren.mockResolvedValue({
      items: [file("index:fixture:8", "/fixture/refreshed.bin")], nextCursor: null,
    });
    rerender(<CleanupSpaceMap snapshot={{ ...current, sampledAtMs: 2_000 }} snapshotStatus="current" onDeletionApplied={vi.fn()} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });

    expect(cleanupApi.getCleanupIndexedChildren).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: /Visible file/ }).getAttribute("title")).toBe("/fixture/refreshed.bin");
  });

  it("keeps the non-indexed list stable after selecting an item", async () => {
    vi.useFakeTimers();
    const current = snapshot();
    current.indexed = false;
    current.root.children = [file("file", "/fixture/file.bin")];
    render(<CleanupSpaceMap snapshot={current} snapshotStatus="current" onDeletionApplied={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    fireEvent.click(screen.getByRole("button", { name: /Visible file/ }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

    expect(cleanupApi.getCleanupIndexedChildren).not.toHaveBeenCalled();
    expect(screen.queryByText("Reading the index…")).toBeNull();
    expect(screen.getByRole("listitem").textContent).toContain("Visible file");
  });

  it("labels category summaries as expandable instead of protected", async () => {
    const current = snapshot();
    current.locations = [{
      kind: "app_cache",
      paths: ["/fixture/cache"],
      sizeBytes: 10,
      itemCount: 1,
      safety: "reclaimable",
      available: true,
      nodes: [folder("index:fixture:8", "Cache", "/fixture/cache")],
    }];

    const { container } = render(
      <CleanupSpaceMap
        snapshot={current}
        snapshotStatus="current"
        command={{ id: 1, type: "showReclaimable" }}
        onDeletionApplied={vi.fn()}
      />,
    );

    expect(await screen.findByText("Showing potentially reclaimable categories")).toBeTruthy();
    expect(container.querySelector(".cleanup-map__selection small")?.textContent).toContain("Summary · open");
    expect(screen.queryByText("Protected")).toBeNull();
    expect(container.querySelector(".cleanup-map__plan.is-collapsed")).toBeNull();
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

  it("reconciles an expired scan generation instead of exposing a missing-node error", async () => {
    const current = snapshot();
    cleanupApi.getCleanupIndexedDirectory.mockRejectedValue({
      code: "cleanup_index_node_missing",
      message: "The selected folder is not available in this scan index.",
    });
    const latest = snapshot();
    latest.scanId = "new-generation";
    latest.root.id = "index:new-generation:1";
    const onReloadLatestSnapshot = vi.fn().mockResolvedValue(latest);
    render(
      <CleanupSpaceMap
        snapshot={current}
        snapshotStatus="current"
        onDeletionApplied={vi.fn()}
        onReloadLatestSnapshot={onReloadLatestSnapshot}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /First folder/ }));

    await waitFor(() => expect(onReloadLatestSnapshot).toHaveBeenCalledOnce());
    expect(screen.queryByText(/selected folder is not available/i)).toBeNull();
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

  it("reloads a refreshed directory together with its indexed parent chain", async () => {
    const current = snapshot();
    const first = current.root.children[0];
    const deep = folder("index:fixture:4", "Deep folder", "/fixture/first/deep");
    first.children = [deep];
    cleanupApi.getCleanupIndexedDirectory.mockImplementation(
      async ({ directoryId }: { directoryId: string }) => directoryId === deep.id
        ? { ...deep, children: [file("index:fixture:5", "/fixture/first/deep/file.bin")] }
        : { ...first, children: [deep] },
    );
    const status = refreshStatus(deep.id);
    status.phase = "completed";
    status.resultAvailable = true;

    render(
      <CleanupSpaceMap
        snapshot={{ ...current, sampledAtMs: 2_000 }}
        snapshotStatus="current"
        onDeletionApplied={vi.fn()}
        directoryRefreshStatus={status}
      />,
    );

    await waitFor(() => expect(cleanupApi.getCleanupIndexedDirectory).toHaveBeenCalledTimes(2));
    expect(cleanupApi.getCleanupIndexedDirectory).toHaveBeenCalledWith({
      scanId: "fixture",
      directoryId: deep.id,
    });
    expect(cleanupApi.getCleanupIndexedDirectory).toHaveBeenCalledWith({
      scanId: "fixture",
      directoryId: first.id,
    });
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function file(id: string, path: string): CleanupNode {
  return {
    ...folder(id, "Visible file", path, false),
    kind: "file",
  };
}

function aggregate(): CleanupNode {
  return {
    ...folder("index:fixture:1#other-items", "Other content", "", false),
    path: null,
    kind: "aggregate",
    deletionProtected: true,
    protectionReason: "aggregate",
  };
}

function deferredAggregate(): CleanupNode {
  return {
    ...aggregate(),
    hasChildren: true,
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
