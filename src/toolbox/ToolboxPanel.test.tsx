/** @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ToolboxPanel } from "./ToolboxPanel";

const modules = vi.hoisted(() => {
  let releaseImage: () => void = () => undefined;
  const imageReady = new Promise<void>((resolve) => { releaseImage = resolve; });
  return { imageLoaded: vi.fn(), patchLoaded: vi.fn(), getToolboxSnapshot: vi.fn(), imageReady, releaseImage };
});

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: () => "正在加载" }) }));
vi.mock("../api", () => ({ isDesktopRuntime: () => true }));
vi.mock("./client", () => ({
  getToolboxNetworkSnapshot: vi.fn(),
  getToolboxSnapshot: modules.getToolboxSnapshot,
}));
vi.mock("./image/ImageToolbox", async () => {
  modules.imageLoaded();
  await modules.imageReady;
  return { ImageToolbox: ({ toolId }: { toolId: string }) => <div data-testid="image-tool">{toolId}</div> };
});
vi.mock("./binary-patch/BinaryPatchToolbox", () => {
  modules.patchLoaded();
  return { BinaryPatchToolbox: ({ toolId }: { toolId: string }) => <div data-testid="patch-tool">{toolId}</div> };
});

beforeEach(() => {
  modules.getToolboxSnapshot.mockResolvedValue(toolboxSnapshot());
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("loads image and patch modules only on demand while retaining the page navigation", async () => {
  render(<ToolboxPanel />);
  expect(modules.imageLoaded).not.toHaveBeenCalled();
  expect(modules.patchLoaded).not.toHaveBeenCalled();

  fireEvent.click(screen.getByText("图片水印").closest("button")!);
  expect(screen.getByRole("status").textContent).toBe("正在加载");
  expect(screen.getByRole("button", { name: "返回工具箱" })).toBeTruthy();
  await act(async () => { modules.releaseImage(); });
  expect((await screen.findByTestId("image-tool")).textContent).toBe("image-watermark");
  expect(modules.imageLoaded).toHaveBeenCalledOnce();
  expect(modules.patchLoaded).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "返回工具箱" }));
  fireEvent.click(screen.getByText("生成补丁").closest("button")!);
  expect((await screen.findByTestId("patch-tool")).textContent).toBe("binary-patch-create");
  expect(modules.patchLoaded).toHaveBeenCalledOnce();
});

it("keeps browser-local tools available even when an older native snapshot marks them unavailable", async () => {
  modules.getToolboxSnapshot.mockResolvedValue(toolboxSnapshot({
    json: unavailable("错误的原生 helper 标签不应阻止本地 JSON。"),
    "keyboard-cleaning": unavailable("当前平台没有经过验证的受限键盘 hook。"),
  }));

  render(<ToolboxPanel />);
  await act(async () => { await Promise.resolve(); });

  const keyboardCleaning = screen.getByText("键盘清洁").closest("button")!;
  expect((keyboardCleaning as HTMLButtonElement).disabled).toBe(true);
  expect(keyboardCleaning.textContent).toContain("不可用：当前平台没有经过验证的受限键盘 hook。");

  const json = screen.getByText("JSON").closest("button")!;
  expect((json as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(json);
  expect(screen.getByRole("heading", { name: "JSON" })).toBeTruthy();
});

it("shows a degraded notice but still opens the tool", async () => {
  modules.getToolboxSnapshot.mockResolvedValue(toolboxSnapshot({
    "file-sha256": { state: "degraded", reason: "文件选择集成暂时受限。", platform: "macOS" },
  }));

  render(<ToolboxPanel />);
  await act(async () => { await Promise.resolve(); });

  const fileHash = screen.getByText("文件 SHA-256").closest("button")!;
  expect((fileHash as HTMLButtonElement).disabled).toBe(false);
  expect(fileHash.textContent).toContain("降级可用：文件选择集成暂时受限。");
  fireEvent.click(fileHash);
  expect(screen.getByRole("heading", { name: "文件 SHA-256" })).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain("降级可用：文件选择集成暂时受限。");
});

function unavailable(reason: string) {
  return { state: "unavailable" as const, reason, platform: "macOS" };
}

function toolboxSnapshot(capabilities: Record<string, unknown> = {}) {
  return { capabilities } as never;
}
