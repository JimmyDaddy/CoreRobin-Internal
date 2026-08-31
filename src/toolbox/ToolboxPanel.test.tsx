/** @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ToolboxPanel } from "./ToolboxPanel";

const modules = vi.hoisted(() => {
  let releaseImage: () => void = () => undefined;
  const imageReady = new Promise<void>((resolve) => { releaseImage = resolve; });
  return { imageLoaded: vi.fn(), patchLoaded: vi.fn(), getToolboxSnapshot: vi.fn(), imageReady, releaseImage };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      const translations: Record<string, string> = {
        title: "工具箱",
        description: "在本机处理文本、图片、文件和系统小委托。普通输入只停留在当前页面。",
        loading: "正在加载",
        "categories.label": "工具分类",
        "categories.systemNetwork": "系统与网络",
        "categories.textDevelopment": "文本与开发",
        "categories.image": "图片",
        "categories.filePatch": "文件与补丁",
        "capability.degraded": "降级可用",
        "capability.unavailable": "不可用",
        "navigation.back": "返回工具箱",
        "tools.image-watermark.title": "图片水印",
        "tools.file-sha256.title": "文件 SHA-256",
        "tools.keyboard-cleaning.title": "键盘清洁",
        "tools.json.title": "JSON",
        "tools.binary-patch-create.title": "生成补丁",
      };
      const template = translations[key] ?? key;
      return template.replace(/\{(\w+)\}/g, (_, name: string) => String(values?.[name] ?? `{${name}}`));
    },
  }),
}));
vi.mock("../api", () => ({ isDesktopRuntime: () => true }));
vi.mock("./client", () => ({
  getToolboxNetworkSnapshot: vi.fn(),
  getToolboxSnapshot: modules.getToolboxSnapshot,
  subscribeToolboxEvents: vi.fn().mockResolvedValue(() => undefined),
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

it("keeps the toolbox region labelled when entering a tool page", () => {
  render(<ToolboxPanel />);

  expect(screen.getByRole("region", { name: "工具箱" }).getAttribute("aria-labelledby")).toBe("toolbox-title");

  fireEvent.click(screen.getByText("JSON").closest("button")!);

  const toolPage = screen.getByRole("region", { name: "JSON" });
  expect(toolPage.getAttribute("aria-labelledby")).toBe("toolbox-tool-title");
  expect(screen.getByRole("heading", { name: "JSON" }).id).toBe("toolbox-tool-title");
});

function unavailable(reason: string) {
  return { state: "unavailable" as const, reason, platform: "macOS" };
}

function toolboxSnapshot(capabilities: Record<string, unknown> = {}) {
  return { capabilities } as never;
}
