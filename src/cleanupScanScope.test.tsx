/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CleanupAssistant } from "./components/CleanupAssistant";
import { CLEANUP_RECENT_TARGETS_STORAGE_KEY } from "./cleanupScanTargets";
import i18n from "./i18n";
import { getMockCleanupScan } from "./mockData";

const api = vi.hoisted(() => ({
  open: vi.fn(),
  getCleanupScanAccess: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: api.open }));
vi.mock("./api", () => ({ getCleanupScanAccess: api.getCleanupScanAccess }));
vi.mock("./components/CleanupSpaceMap", () => ({ CleanupSpaceMap: () => <div data-testid="scan-result" /> }));

beforeEach(async () => {
  window.localStorage.clear();
  vi.clearAllMocks();
  api.open.mockReset();
  api.getCleanupScanAccess.mockResolvedValue({ fullDiskAccess: "granted", fullDiskAccessRecommended: false });
  await i18n.changeLanguage("zh-CN");
});
afterEach(cleanup);

describe("cleanup scan scope selection", () => {
  it("keeps the folder card selected after adding it to recent locations", async () => {
    api.open.mockResolvedValue("/Users/demo/Projects");
    const onScan = vi.fn();
    renderScope({ onScan });
    fireEvent.click(screen.getByRole("button", { name: "选择文件夹" }));
    await screen.findByRole("button", { name: "选择文件夹", pressed: true });
    expect(document.querySelector(".cleanup-targets__selected-path")?.textContent).toContain("/Users/demo/Projects");
    expect(screen.getByText("最近位置")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "开始只读扫描" }));
    expect(onScan).toHaveBeenCalledWith({ targetKind: "folder", targetPath: "/Users/demo/Projects", profile: "complete" });
    expect(api.getCleanupScanAccess).not.toHaveBeenCalled();
  });

  it("keeps the current folder when the native picker is cancelled and reopens at that path", async () => {
    api.open.mockResolvedValueOnce("/Users/demo/Projects").mockResolvedValueOnce(null);
    renderScope();
    fireEvent.click(screen.getByRole("button", { name: "选择文件夹" }));
    await screen.findByRole("button", { name: "选择文件夹", pressed: true });
    fireEvent.click(screen.getByRole("button", { name: "选择文件夹" }));
    await waitFor(() => expect(api.open).toHaveBeenCalledTimes(2));
    expect(api.open).toHaveBeenLastCalledWith(expect.objectContaining({ defaultPath: "/Users/demo/Projects", directory: true, multiple: false }));
    expect(document.querySelector(".cleanup-targets__selected-path")?.textContent).toContain("/Users/demo/Projects");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows picker failures near the scope and allows a successful retry", async () => {
    api.open.mockRejectedValueOnce(new Error("dialog unavailable")).mockResolvedValueOnce("/Users/demo/Documents");
    renderScope();
    fireEvent.click(screen.getByRole("button", { name: "选择文件夹" }));
    const error = await screen.findByRole("alert");
    expect(error.textContent).toContain("无法打开文件夹选择器");
    fireEvent.click(within(error).getByRole("button", { name: "重试" }));
    await screen.findByRole("button", { name: "选择文件夹", pressed: true });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("dismisses system-disk permission guidance when switching to a specific folder", async () => {
    api.getCleanupScanAccess.mockResolvedValue({ fullDiskAccess: "not_granted", fullDiskAccessRecommended: true, applicationBundleAvailable: true });
    api.open.mockResolvedValue("/Users/demo/Projects");
    const onScan = vi.fn();
    renderScope({ onScan });
    fireEvent.click(screen.getByRole("button", { name: "开始只读扫描" }));
    await screen.findByRole("heading", { name: "允许查看整个系统磁盘" });
    fireEvent.click(screen.getByRole("button", { name: "选择文件夹" }));
    await screen.findByRole("button", { name: "选择文件夹", pressed: true });
    expect(screen.queryByRole("heading", { name: "允许查看整个系统磁盘" })).toBeNull();
    expect(onScan).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "开始只读扫描" }));
    expect(onScan).toHaveBeenCalledWith({ targetKind: "folder", targetPath: "/Users/demo/Projects", profile: "complete" });
  });

  it("does not start a scan or switch target while a folder choice is pending", async () => {
    let finish!: (value: null) => void;
    api.open.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const onScan = vi.fn();
    renderScope({ onScan });
    fireEvent.click(screen.getByRole("button", { name: "选择文件夹" }));
    expect((screen.getByRole("button", { name: /^系统磁盘/ }) as HTMLButtonElement).disabled).toBe(true);
    const start = screen.getByRole("button", { name: "开始只读扫描" }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    fireEvent.click(start);
    expect(onScan).not.toHaveBeenCalled();
    await act(async () => finish(null));
    expect(start.disabled).toBe(false);
  });

  it.each(["快速扫描", "完整扫描"])("remembers %s when returning from a folder", async (profile) => {
    api.open.mockResolvedValue("/Users/demo/Projects");
    renderScope();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${profile}`) }));
    fireEvent.click(screen.getByRole("button", { name: "选择文件夹" }));
    await screen.findByRole("button", { name: "选择文件夹", pressed: true });
    fireEvent.click(screen.getByRole("button", { name: /^系统磁盘/ }));
    expect(screen.getByRole("button", { name: new RegExp(`^${profile}`), pressed: true })).toBeTruthy();
  });

  it("preserves an unscanned choice across same-scan snapshot updates and permits collapsing it", () => {
    const snapshot = getMockCleanupScan();
    const view = renderScope({ snapshot });
    fireEvent.click(screen.getByRole("button", { name: "修改范围" }));
    fireEvent.click(screen.getByRole("button", { name: /^快速扫描/ }));
    view.rerender(<CleanupAssistant {...view.props} snapshot={{ ...snapshot }} />);
    expect(screen.getByRole("button", { name: /^快速扫描/, pressed: true })).toBeTruthy();
    expect(screen.getByText("待扫描")).toBeTruthy();
    expect(screen.getByRole("button", { name: "开始只读扫描" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "收起" }));
    expect(screen.getByRole("button", { name: "修改范围" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("待扫描")).toBeTruthy();
    view.rerender(<CleanupAssistant {...view.props} snapshot={{ ...snapshot, scanId: "new-scan" }} />);
    expect(screen.queryByText("待扫描")).toBeNull();
  });

  it("distinguishes same-named recent folders by path, including Windows paths", () => {
    window.localStorage.setItem(CLEANUP_RECENT_TARGETS_STORAGE_KEY, JSON.stringify([
      { targetKind: "folder", targetPath: "/Users/demo/Work/Reports" },
      { targetKind: "folder", targetPath: "C:\\Archive\\Reports" },
    ]));
    const onScan = vi.fn();
    renderScope({ onScan });
    const recent = document.querySelector(".cleanup-targets__recent") as HTMLElement;
    expect(within(recent).getAllByText("Reports")).toHaveLength(2);
    fireEvent.click(within(recent).getByRole("button", { name: "Reports C:\\Archive\\Reports" }));
    fireEvent.click(screen.getByRole("button", { name: "开始只读扫描" }));
    expect(onScan).toHaveBeenCalledWith({ targetKind: "folder", targetPath: "C:\\Archive\\Reports", profile: "complete" });
  });

  it("selects a mounted volume explicitly and uses a complete scan of that volume", () => {
    const onScan = vi.fn();
    renderScope({ onScan, volumes: [{ name: "Archive", mountPoint: "/Volumes/Archive", totalBytes: 1024, availableBytes: 512, removable: true }] });
    fireEvent.click(screen.getByRole("button", { name: /^Archive/ }));
    expect(screen.getByRole("button", { name: /^Archive/, pressed: true })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^快速扫描/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "开始只读扫描" }));
    expect(onScan).toHaveBeenCalledWith({ targetKind: "volume", targetPath: "/Volumes/Archive", profile: "complete" });
  });
});

function renderScope(overrides: Partial<ComponentProps<typeof CleanupAssistant>> = {}) {
  const props: ComponentProps<typeof CleanupAssistant> = {
    snapshot: null, error: null, loading: false, cancelling: false, phase: null, progress: null,
    snapshotStatus: "current", onScan: vi.fn(), onCancel: vi.fn(), onDeletionApplied: async () => undefined,
    onReloadLatestSnapshot: async () => null,
    fileInsights: { snapshot: null, snapshotStatus: "current", progress: null, loading: false, error: null, scan: async () => undefined, cancel: async () => undefined, clear: async () => undefined, removePaths: () => undefined },
    ...overrides,
  };
  return { ...render(<CleanupAssistant {...props} />), props };
}
