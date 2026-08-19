/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CleanupAssistant } from "./components/CleanupAssistant";
import type { FileInsightsScanController } from "./hooks/useFileInsightsScan";
import i18n from "./i18n";
import { getMockCleanupScan } from "./mockData";
import type {
  CleanupScanJobPhase,
  CleanupScanProgress,
  CleanupScanTarget,
  CommandError,
} from "./types";

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
  getCleanupScanAccess: vi.fn(),
  loadPersistedFileInsightsScan: vi.fn().mockResolvedValue(null),
  openCleanupFullDiskAccessSettings: vi.fn(),
  revealCleanupApplicationBundle: vi.fn(),
  setCleanupDeleteLeaseMode: vi.fn(),
}));

vi.mock("./api", () => cleanupApi);
vi.mock("./components/CleanupSunburstCanvas", () => ({
  CleanupSunburstCanvas: () => <div data-testid="cleanup-map-canvas" />,
}));

afterEach(() => cleanup());
beforeEach(async () => {
  window.localStorage.clear();
  cleanupApi.getCleanupScanAccess.mockReset();
  cleanupApi.openCleanupFullDiskAccessSettings.mockReset();
  cleanupApi.revealCleanupApplicationBundle.mockReset();
  await i18n.changeLanguage("zh-CN");
});

describe("cleanup full disk access guide", () => {
  it("reconciles a background-completed scan whenever the cleanup page opens", async () => {
    const onReloadLatestSnapshot = vi.fn().mockResolvedValue(null);

    renderAssistant(vi.fn(), null, false, null, null, onReloadLatestSnapshot);

    await waitFor(() => expect(onReloadLatestSnapshot).toHaveBeenCalledOnce());
  });

  it("starts with one focused scan action and keeps secondary tools out of the way", () => {
    renderAssistant(vi.fn());

    expect(screen.getByRole("heading", { name: "先看清楚，再决定是否处理" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "开始只读扫描" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /重复与长期未修改文件/ })).toBeNull();
  });

  it("keeps quick and complete system scans explicit and forwards the selected profile", async () => {
    cleanupApi.getCleanupScanAccess.mockResolvedValue({
      fullDiskAccess: "granted",
      fullDiskAccessRecommended: true,
      applicationBundleAvailable: true,
      applicationBundlePath: "/Applications/CoreRobin.app",
    });
    const onScan = vi.fn();
    renderAssistant(onScan);

    expect(screen.getByText(/下载、桌面、文稿/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "开始只读扫描" }));
    await waitFor(() => expect(onScan).toHaveBeenCalledWith({
      profile: "common_locations",
      targetKind: "system_disk",
      targetPath: null,
    }));

    onScan.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /完整扫描/ }));
    fireEvent.click(screen.getByRole("button", { name: "开始只读扫描" }));
    await waitFor(() => expect(onScan).toHaveBeenCalledWith({
      profile: "complete",
      targetKind: "system_disk",
      targetPath: null,
    }));
  });

  it("offers a limited scan instead of blocking when access is not granted", async () => {
    cleanupApi.getCleanupScanAccess.mockResolvedValue({
      fullDiskAccess: "not_granted",
      fullDiskAccessRecommended: true,
      applicationBundleAvailable: true,
      applicationBundlePath: "/Applications/CoreRobin.app",
    });
    const onScan = vi.fn();
    renderAssistant(onScan);

    fireEvent.click(screen.getByRole("button", { name: "开始只读扫描" }));

    expect(await screen.findByRole("heading", { name: "允许查看整个系统磁盘" })).toBeTruthy();
    expect(onScan).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "扫描可访问区域" }));
    expect(onScan).toHaveBeenCalledOnce();
  });

  it("rechecks access after returning from System Settings and starts automatically", async () => {
    cleanupApi.getCleanupScanAccess
      .mockResolvedValueOnce({
        fullDiskAccess: "not_granted",
        fullDiskAccessRecommended: true,
        applicationBundleAvailable: true,
        applicationBundlePath: "/Applications/CoreRobin.app",
      })
      .mockResolvedValueOnce({
        fullDiskAccess: "granted",
        fullDiskAccessRecommended: true,
        applicationBundleAvailable: true,
        applicationBundlePath: "/Applications/CoreRobin.app",
      });
    cleanupApi.openCleanupFullDiskAccessSettings.mockResolvedValue(undefined);
    const onScan = vi.fn();
    renderAssistant(onScan);

    fireEvent.click(screen.getByRole("button", { name: "开始只读扫描" }));
    fireEvent.click(await screen.findByRole("button", { name: "打开完全磁盘访问权限" }));
    await waitFor(() => expect(cleanupApi.openCleanupFullDiskAccessSettings).toHaveBeenCalledOnce());
    await screen.findByText(/如果列表中没有 CoreRobin/);
    fireEvent(window, new Event("focus"));

    await waitFor(() => expect(onScan).toHaveBeenCalledOnce());
  });

  it("reveals the running app bundle so it can be added with the plus button", async () => {
    cleanupApi.getCleanupScanAccess.mockResolvedValue({
      fullDiskAccess: "not_granted",
      fullDiskAccessRecommended: true,
      applicationBundleAvailable: true,
      applicationBundlePath: "/Applications/CoreRobin.app",
    });
    cleanupApi.revealCleanupApplicationBundle.mockResolvedValue(undefined);
    renderAssistant(vi.fn());

    fireEvent.click(screen.getByRole("button", { name: "开始只读扫描" }));
    expect(await screen.findByText("点击 +，选择 CoreRobin.app")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "在访达中显示应用" }));

    await waitFor(() => expect(cleanupApi.revealCleanupApplicationBundle).toHaveBeenCalledOnce());
  });

  it("explains why a development process is absent from the permission list", async () => {
    cleanupApi.getCleanupScanAccess.mockResolvedValue({
      fullDiskAccess: "not_granted",
      fullDiskAccessRecommended: true,
      applicationBundleAvailable: false,
      applicationBundlePath: null,
    });
    renderAssistant(vi.fn());

    fireEvent.click(screen.getByRole("button", { name: "开始只读扫描" }));

    expect(await screen.findByText("当前运行的不是可授权的应用包")).toBeTruthy();
    expect(screen.getByRole("button", { name: "扫描可访问区域" }).classList.contains("button--primary")).toBe(true);
    expect((screen.getByRole("button", { name: "需先从 CoreRobin.app 启动" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "在访达中显示应用" })).toBeNull();
  });

  it("turns scan findings into direct map and cleanup-basket actions", async () => {
    renderAssistant(vi.fn(), getMockCleanupScan());

    const moreResults = document.querySelector<HTMLElement>(
      ".cleanup-results__more > summary",
    );
    expect(moreResults).not.toBeNull();
    fireEvent.click(moreResults!);

    const categoryButtons = screen.getAllByRole("button", { name: "用途分类" });
    fireEvent.click(categoryButtons[1]);
    await waitFor(() =>
      expect(screen.getByRole("button", {
        name: "用途分类",
        pressed: true,
      })).toBeTruthy(),
    );

    fireEvent.click(screen.getAllByRole("button", { name: "清理篮" })[0]);
    expect(await screen.findByText(/已选择 1 项/)).toBeTruthy();
  });

  it("shows the animated scan workspace during a rescan with a retained snapshot", () => {
    renderAssistant(vi.fn(), getMockCleanupScan(), true, {
      scannedEntryCount: 42,
      discoveredBytes: 1_024,
      currentPath: "~/Downloads",
      elapsedMs: 500,
    });

    expect(document.querySelector(".cleanup-scan-stage")).not.toBeNull();
    expect(document.querySelector(".cleanup-scan-orbit")).not.toBeNull();
    expect(document.querySelector(".cleanup-results")).toBeNull();
    expect(document.querySelector(".cleanup-scan-stage[aria-live]")).toBeNull();
    expect(screen.getByRole("status").className).toContain("sr-only");
    expect(screen.getByText("正在分析下载文件")).toBeTruthy();
    expect(screen.getByText("42")).toBeTruthy();
  });

  it("explains that a completed traversal is preparing its indexed result", () => {
    renderAssistant(vi.fn(), null, true, {
      scannedEntryCount: 8_000_000,
      discoveredBytes: 800_000_000_000,
      currentPath: "/",
      elapsedMs: 480_000,
    }, null, async () => null, "finalizing");

    expect(screen.getByRole("heading", { name: "正在整理空间地图" })).toBeTruthy();
    expect(screen.getByText(/文件夹已经扫描完成/)).toBeTruthy();
  });

  it("marks a retained result as the previous scan when a rescan fails", () => {
    renderAssistant(vi.fn(), getMockCleanupScan(), false, null, {
      code: "cleanup_scan_failed",
      message: "Scan failed",
    });

    expect(screen.getByText("Scan failed")).toBeTruthy();
    expect(screen.getByText("正在显示上次扫描结果")).toBeTruthy();
  });

  it("shows a friendly scan location without exposing an internal path prompt", () => {
    renderAssistant(vi.fn(), null, true, {
      scannedEntryCount: 42,
      discoveredBytes: 1_024,
      currentPath: "~/.cargo/registry",
      elapsedMs: 500,
    });

    expect(screen.getByText("正在分析开发工具缓存")).toBeTruthy();
    expect(screen.queryByText("~/.cargo/registry")).toBeNull();
    expect(screen.queryByText("查看当前技术路径")).toBeNull();
  });

  it("localizes an unavailable scan target instead of exposing a native error", () => {
    const nativeMessage = "CoreRobin could not read the selected scan root: Operation not permitted (os error 1)";
    renderAssistant(vi.fn(), null, false, null, {
      code: "cleanup_scan_root_unavailable",
      message: nativeMessage,
    });

    expect(screen.getByText("所选位置当前无法读取。请确认它仍然存在且可访问，然后重试。")).toBeTruthy();
    expect(screen.queryByText(nativeMessage)).toBeNull();
  });

  it("does not describe a stalled system scan as an abnormal folder", () => {
    const nativeMessage = "The selected scan root stopped reporting directory progress.";
    renderAssistant(vi.fn(), null, false, null, {
      code: "cleanup_scan_root_stalled",
      message: nativeMessage,
    });

    expect(screen.getByText(/系统磁盘扫描长时间没有进展/)).toBeTruthy();
    expect(screen.queryByText(/异常文件夹/)).toBeNull();
    expect(screen.queryByText(nativeMessage)).toBeNull();
  });
});

function renderAssistant(
  onScan: (target?: CleanupScanTarget) => void,
  snapshot: ReturnType<typeof getMockCleanupScan> | null = null,
  loading = false,
  progress: CleanupScanProgress | null = null,
  error: CommandError | null = null,
  onReloadLatestSnapshot: () => Promise<ReturnType<typeof getMockCleanupScan> | null> = async () => null,
  phase: CleanupScanJobPhase | null = loading ? "scanning" : null,
) {
  return render(
    <CleanupAssistant
      snapshot={snapshot}
      error={error}
      loading={loading}
      cancelling={false}
      phase={phase}
      progress={progress}
      snapshotStatus="current"
      onScan={onScan}
      onCancel={() => undefined}
      onDeletionApplied={async () => undefined}
      onReloadLatestSnapshot={onReloadLatestSnapshot}
      fileInsights={EMPTY_FILE_INSIGHTS}
    />,
  );
}
