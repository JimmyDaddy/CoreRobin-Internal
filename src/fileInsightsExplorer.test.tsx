/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CleanupAssistant } from "./components/CleanupAssistant";
import { FileInsightsExplorer } from "./components/FileInsightsExplorer";
import type { FileInsightsScanController } from "./hooks/useFileInsightsScan";
import i18n from "./i18n";
import { getMockCleanupScan } from "./mockData";
import type { FileInsightsScan } from "./types";

const EMPTY_FILE_INSIGHTS: FileInsightsScanController = {
  snapshot: null,
  snapshotStatus: "current",
  progress: null,
  loading: false,
  error: null,
  scan: async () => undefined,
  cancel: async () => undefined,
  clear: async () => undefined,
  removePaths: () => undefined,
};

const cleanupApi = vi.hoisted(() => ({
  cancelCleanupDelete: vi.fn(),
  cancelFileInsightsScan: vi.fn(),
  createCleanupDeleteLease: vi.fn(),
  executeCleanupDelete: vi.fn(),
  getCleanupScanAccess: vi.fn(),
  loadPersistedFileInsightsScan: vi.fn().mockResolvedValue(null),
  openCleanupFullDiskAccessSettings: vi.fn(),
  releaseCleanupDeleteLease: vi.fn(),
  revealCleanupApplicationBundle: vi.fn(),
  savePersistedFileInsightsScan: vi.fn().mockResolvedValue(undefined),
  scanFileInsights: vi.fn(),
  setCleanupDeleteLeaseMode: vi.fn(),
}));

vi.mock("./api", () => cleanupApi);
vi.mock("./components/PathActions", () => ({
  PathActions: ({ path }: { path: string }) => <button type="button">{`显示 ${path}`}</button>,
}));
vi.mock("./components/CleanupSpaceMap", () => ({
  CleanupSpaceMap: () => null,
}));

afterEach(() => cleanup());
beforeEach(async () => {
  vi.clearAllMocks();
  cleanupApi.createCleanupDeleteLease.mockImplementation(async (request) => ({
    id: "duplicate-lease",
    mode: request.mode,
    paths: request.paths,
    missingPaths: [],
    unavailablePaths: [],
    changedPaths: [],
    refreshedTargets: request.expectedTargets,
    executable: true,
    refreshedAtMs: RESULT.sampledAtMs + 1,
  }));
  cleanupApi.setCleanupDeleteLeaseMode.mockImplementation(async ({ leaseId, mode }) => ({
    id: leaseId,
    mode,
    paths: ["/Users/demo/Downloads/archive.zip"],
    missingPaths: [],
    unavailablePaths: [],
    changedPaths: [],
    refreshedTargets: [{
      path: "/Users/demo/Downloads/archive.zip",
      logicalSizeBytes: 284_000_000,
      allocatedSizeBytes: 284_000_000,
      itemCount: 1,
    }],
    executable: true,
    refreshedAtMs: RESULT.sampledAtMs + 1,
  }));
  cleanupApi.executeCleanupDelete.mockResolvedValue({
    deleted: [{ path: "/Users/demo/Downloads/archive.zip", deletedBytes: 284_000_000 }],
    deletedBytes: 284_000_000,
    failed: [],
    cancelled: false,
    interruptedPath: null,
  });
  await i18n.changeLanguage("zh-CN");
});

describe("file insights workspace", () => {
  it("combines completed scan facts and actions into one compact overview", () => {
    const scan = {
      ...getMockCleanupScan(),
      profile: "common_locations" as const,
      scopePaths: ["/Users/demo/Downloads", "/Users/demo/Library/Caches"],
    };
    render(
      <CleanupAssistant
        snapshot={scan}
        error={null}
        loading={false}
        cancelling={false}
        phase={null}
        progress={null}
        snapshotStatus="current"
        growthComparison={{
          previousSampledAtMs: scan.sampledAtMs - 60_000,
          currentSampledAtMs: scan.sampledAtMs,
          growthBytes: 0,
          fastestGrowing: [],
        }}
        onScan={() => undefined}
        onCancel={() => undefined}
        onDeletionApplied={async () => undefined}
        fileInsights={EMPTY_FILE_INSIGHTS}
      />,
    );

    const overview = document.querySelector<HTMLElement>(".cleanup-result-overview");
    expect(overview).not.toBeNull();
    expect(overview?.querySelector(".file-insights-launcher.is-compact")).not.toBeNull();
    expect(document.querySelector(".cleanup-result-overview__growth")).toBeNull();
    expect(screen.getByRole("button", { name: "继续完整扫描" })).toBeTruthy();
  });

  it("opens as a separate workspace from the space cleanup page and returns", () => {
    render(
      <CleanupAssistant
        snapshot={getMockCleanupScan()}
        error={null}
        loading={false}
        cancelling={false}
        phase={null}
        progress={null}
        snapshotStatus="current"
        onScan={() => undefined}
        onCancel={() => undefined}
        onDeletionApplied={async () => undefined}
        fileInsights={EMPTY_FILE_INSIGHTS}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /重复与长期未修改文件/ }));
    expect(screen.getByRole("heading", { name: "重复与长期未修改文件" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "磁盘扫描" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "返回空间清理" }));
    expect(screen.getByRole("heading", { name: "磁盘扫描" })).toBeTruthy();
  });

  it("shows a visual phase story and live counters while scanning", () => {
    render(
      <FileInsightsExplorer
        scan={null}
        progress={{
          phase: "hashing",
          scannedEntryCount: 26_156,
          candidateFileCount: 705,
          hashedFileCount: 20,
          currentPath: "/Users/demo/Movies/library/Original Media/example.tiff",
        }}
        loading
        error={null}
        onRun={() => undefined}
        onCancel={() => undefined}
        onBack={() => undefined}
      />,
    );

    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "正在核对重复内容" })).toBeTruthy();
    expect(screen.getByText("26,156")).toBeTruthy();
    expect(screen.getByText("705")).toBeTruthy();
    expect(screen.getByText("20")).toBeTruthy();
  });

  it("presents duplicate groups and long-unmodified files as switchable result views", () => {
    render(
      <FileInsightsExplorer
        scan={RESULT}
        progress={null}
        loading={false}
        error={null}
        onRun={() => undefined}
        onCancel={() => undefined}
        onBack={() => undefined}
      />,
    );

    expect(screen.getAllByText("archive.zip").length).toBeGreaterThan(0);
    expect(screen.getAllByText("270.8 MB").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: /180 天未修改且超过 100 MB/ }));
    expect(screen.getByText("old-video.mov")).toBeTruthy();
    expect(screen.queryByText("archive.zip")).toBeNull();
  });

  it("keeps a 100-group result inside an independently scrollable results region", () => {
    const duplicateGroups = Array.from({ length: 100 }, (_, index) => ({
      ...RESULT.duplicateGroups[0],
      digest: `digest-${index}`,
      files: RESULT.duplicateGroups[0].files.map((file, fileIndex) => ({
        ...file,
        name: `copy-${index + 1}-${fileIndex + 1}.zip`,
        path: `/Users/demo/Downloads/copy-${index + 1}-${fileIndex + 1}.zip`,
      })),
    }));
    render(
      <FileInsightsExplorer
        scan={{ ...RESULT, duplicateGroups }}
        progress={null}
        loading={false}
        error={null}
        onRun={() => undefined}
        onCancel={() => undefined}
        onBack={() => undefined}
      />,
    );

    const resultRegion = document.querySelector<HTMLElement>(".file-insights-results__content");
    expect(resultRegion?.getAttribute("role")).toBe("region");
    expect(resultRegion?.tabIndex).toBe(0);
    expect(document.querySelectorAll(".duplicate-group")).toHaveLength(100);
    const shortGroupFiles = document.querySelector<HTMLElement>(".duplicate-group__files");
    expect(shortGroupFiles?.classList.contains("is-scrollable")).toBe(false);
    expect(shortGroupFiles?.getAttribute("role")).toBeNull();
  });

  it("labels restored data and keeps the savings icon alone at the ring center", () => {
    render(
      <FileInsightsExplorer
        scan={RESULT}
        snapshotStatus="cached"
        progress={null}
        loading={false}
        error={null}
        onRun={() => undefined}
        onCancel={() => undefined}
        onBack={() => undefined}
      />,
    );

    expect(screen.getByText("正在显示上次扫描结果")).toBeTruthy();
    const ring = document.querySelector<HTMLElement>(".file-insights-results__saving > span");
    expect(ring?.children).toHaveLength(1);
    expect(ring?.querySelector("svg")).not.toBeNull();
  });

  it("makes a long identical-file list independently keyboard scrollable", () => {
    const longGroup = {
      ...RESULT.duplicateGroups[0],
      files: Array.from({ length: 8 }, (_, index) => ({
        ...RESULT.duplicateGroups[0].files[0],
        name: `archive-copy-${index + 1}.zip`,
        path: `/Users/demo/Downloads/archive-copy-${index + 1}.zip`,
      })),
    };
    render(
      <FileInsightsExplorer
        scan={{ ...RESULT, duplicateGroups: [longGroup] }}
        progress={null}
        loading={false}
        error={null}
        onRun={() => undefined}
        onCancel={() => undefined}
        onBack={() => undefined}
      />,
    );

    const fileList = document.querySelector<HTMLElement>(".duplicate-group__files");
    expect(fileList).not.toBeNull();
    expect(fileList?.getAttribute("role")).toBe("region");
    expect(fileList?.tabIndex).toBe(0);
    expect(fileList?.getAttribute("aria-label")).toContain("8");
    expect(fileList?.classList.contains("is-scrollable")).toBe(true);
  });

  it("keeps one explicit copy and safely processes only the selected extras", async () => {
    const onFilesRemoved = vi.fn();
    const onDeletionApplied = vi.fn().mockResolvedValue(undefined);
    render(
      <FileInsightsExplorer
        scan={RESULT}
        progress={null}
        loading={false}
        error={null}
        onRun={() => undefined}
        onCancel={() => undefined}
        onBack={() => undefined}
        onFilesRemoved={onFilesRemoved}
        onDeletionApplied={onDeletionApplied}
      />,
    );

    const reviewButton = screen.getByRole("button", { name: "检查处理方式" });
    expect(reviewButton.hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "处理本组副本" }));
    expect(screen.getByRole("radio", { name: "将 archive.zip 设为保留项" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "将 archive copy.zip 设为保留项" }));
    expect(screen.getByText("待处理")).toBeTruthy();
    fireEvent.click(reviewButton);

    await waitFor(() => expect(cleanupApi.createCleanupDeleteLease).toHaveBeenCalledWith(
      expect.objectContaining({
        paths: ["/Users/demo/Downloads/archive.zip"],
        mode: "trash",
      }),
    ));
    expect(screen.getByRole("heading", { name: "处理重复文件" })).toBeTruthy();
    const confirmTrash = await waitFor(() => {
      const button = screen.getByRole("button", { name: "移到废纸篓（1 项）" });
      expect(button.hasAttribute("disabled")).toBe(false);
      return button;
    });
    fireEvent.click(confirmTrash);

    await waitFor(() => expect(onFilesRemoved).toHaveBeenCalledWith([
      "/Users/demo/Downloads/archive.zip",
    ]));
    expect(onDeletionApplied).toHaveBeenCalledWith([
      expect.objectContaining({ path: "/Users/demo/Downloads/archive.zip" }),
    ], false);
  });

  it("uses long-unmodified file guidance when adding old files to the cleanup basket", async () => {
    render(
      <FileInsightsExplorer
        scan={RESULT}
        progress={null}
        loading={false}
        error={null}
        onRun={() => undefined}
        onCancel={() => undefined}
        onBack={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", {
      name: /180 天未修改且超过 100 MB/,
    }));
    fireEvent.click(screen.getByRole("checkbox", {
      name: "选择 old-video.mov 进入清理复核",
    }));
    fireEvent.click(screen.getByRole("button", { name: "检查清理方式" }));

    await waitFor(() => expect(cleanupApi.createCleanupDeleteLease).toHaveBeenCalledWith(
      expect.objectContaining({
        paths: ["/Users/demo/Movies/old-video.mov"],
        mode: "trash",
      }),
    ));
    expect(screen.getByRole("heading", { name: "处理长期未修改文件" })).toBeTruthy();
    expect(screen.getByText(/已不存在的文件会自动跳过/)).toBeTruthy();
    expect(screen.queryByText(/每个重复组至少保留一份/)).toBeNull();
  });

  it("switches deletion modes without rebuilding or revalidating the lease", async () => {
    render(
      <FileInsightsExplorer
        scan={RESULT}
        progress={null}
        loading={false}
        error={null}
        onRun={() => undefined}
        onCancel={() => undefined}
        onBack={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "处理本组副本" }));
    fireEvent.click(screen.getByRole("radio", { name: "将 archive copy.zip 设为保留项" }));
    fireEvent.click(screen.getByRole("button", { name: "检查处理方式" }));
    await waitFor(() => expect(cleanupApi.createCleanupDeleteLease).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole("radio", { name: /直接删除/ }));
    await waitFor(() => expect(cleanupApi.setCleanupDeleteLeaseMode).toHaveBeenLastCalledWith({
      leaseId: "duplicate-lease",
      mode: "permanent",
    }));
    fireEvent.click(screen.getByRole("radio", { name: /移到废纸篓/ }));
    await waitFor(() => expect(cleanupApi.setCleanupDeleteLeaseMode).toHaveBeenLastCalledWith({
      leaseId: "duplicate-lease",
      mode: "trash",
    }));

    expect(cleanupApi.createCleanupDeleteLease).toHaveBeenCalledOnce();
    expect(cleanupApi.releaseCleanupDeleteLease).not.toHaveBeenCalled();
    expect(screen.queryByText("正在重新核对路径与文件状态…")).toBeNull();
  });
});

const RESULT: FileInsightsScan = {
  sampledAtMs: Date.now(),
  durationMs: 1_240,
  scannedEntryCount: 8_920,
  candidateFileCount: 412,
  hashedFileCount: 78,
  duplicateGroups: [{
    digest: "demo",
    sizeBytes: 284_000_000,
    reclaimableBytes: 284_000_000,
    files: [
      { name: "archive.zip", path: "/Users/demo/Downloads/archive.zip", sizeBytes: 284_000_000, logicalSizeBytes: 284_000_000, allocatedSizeBytes: 284_000_000, modifiedAtMs: Date.now() - 20_000_000 },
      { name: "archive copy.zip", path: "/Users/demo/Documents/archive copy.zip", sizeBytes: 284_000_000, logicalSizeBytes: 284_000_000, allocatedSizeBytes: 284_000_000, modifiedAtMs: Date.now() - 18_000_000 },
    ],
  }],
  longUnmodifiedFiles: [{
    name: "old-video.mov",
    path: "/Users/demo/Movies/old-video.mov",
    sizeBytes: 1_800_000_000,
    logicalSizeBytes: 1_800_000_000,
    allocatedSizeBytes: 1_800_000_000,
    modifiedAtMs: Date.now() - 250 * 86_400_000,
  }],
  unreadableEntryCount: 0,
  truncated: false,
};
