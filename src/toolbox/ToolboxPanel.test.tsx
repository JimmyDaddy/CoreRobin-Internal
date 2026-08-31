/** @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ToolboxPanel } from "./ToolboxPanel";

type TestSnapshot = {
  capabilities: Record<string, unknown>;
  serviceInstanceId: string;
  revision: number;
};

const i18n = vi.hoisted(() => ({
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
      "tools.text-sha256.title": "文本 SHA-256",
      "tools.keep-awake.title": "限时保活",
      "tools.url.title": "URL",
      "tools.time.title": "时间转换",
      "local.textHash.placeholder": "输入文本",
      "local.textHash.compute": "计算 SHA-256",
      "local.time.placeholder": "Unix 时间或带时区的 ISO 时间",
      "local.convert": "转换",
      "local.run": "运行",
      "keepAwake.durationLabel": "时长",
      "keepAwake.start": "开始保活",
      "keepAwake.stop": "停止并释放",
      "binaryPatch.inputs.expected": "期望摘要",
      "errors.invalidPercentEncoding": "百分号编码无效",
      "errors.invalidIso": "ISO 日期无效",
      showMore: "再显示 {count} 条",
    };
    const template = translations[key] ?? key;
    return template.replace(/\{(\w+)\}/g, (_, name: string) => String(values?.[name] ?? `{${name}}`));
  },
}));

const modules = vi.hoisted(() => {
  let releaseImage: () => void = () => undefined;
  const imageReady = new Promise<void>((resolve) => { releaseImage = resolve; });
  return {
    imageLoaded: vi.fn(),
    patchLoaded: vi.fn(),
    getToolboxSnapshot: vi.fn(),
    subscribeToolboxEvents: vi.fn(),
    getToolboxStorageSnapshot: vi.fn(),
    listToolboxHistory: vi.fn(),
    startToolboxKeepAwake: vi.fn(),
    cancelToolboxKeepAwake: vi.fn(),
    imageReady,
    releaseImage,
    snapshotListener: null as ((event: { type: "snapshot"; snapshot: TestSnapshot }) => void) | null,
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: i18n.t }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => undefined) }));
vi.mock("../api", () => ({
  isDesktopRuntime: () => true,
  getToolboxStorageSnapshot: modules.getToolboxStorageSnapshot,
  listToolboxHistory: modules.listToolboxHistory,
  startToolboxKeepAwake: modules.startToolboxKeepAwake,
  cancelToolboxKeepAwake: modules.cancelToolboxKeepAwake,
}));
vi.mock("./client", () => ({
  getToolboxNetworkSnapshot: vi.fn(),
  getToolboxSnapshot: modules.getToolboxSnapshot,
  selectNewerToolboxSnapshot: (current: TestSnapshot | null, candidate: TestSnapshot) => {
    if (current === null) return candidate;
    if (candidate.serviceInstanceId !== current.serviceInstanceId || candidate.revision < current.revision) return current;
    return candidate;
  },
  subscribeToolboxEvents: modules.subscribeToolboxEvents,
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
  modules.snapshotListener = null;
  modules.getToolboxSnapshot.mockResolvedValue(toolboxSnapshot());
  modules.subscribeToolboxEvents.mockImplementation(async (callback) => {
    modules.snapshotListener = callback;
    return () => undefined;
  });
  modules.getToolboxStorageSnapshot.mockResolvedValue({ policy: { toolboxHistoryEnabled: true } });
  modules.listToolboxHistory.mockResolvedValue(historyPage());
  modules.startToolboxKeepAwake.mockResolvedValue({ status: "active" });
  modules.cancelToolboxKeepAwake.mockResolvedValue({ status: "cancelled" });
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
  expect(document.activeElement).toBe(screen.getByRole("heading", { name: "JSON" }));
});

it("uses the retained snapshot as the initial service baseline before replaying events", async () => {
  const order: string[] = [];
  let resolveSnapshot: (snapshot: TestSnapshot) => void = () => undefined;
  modules.subscribeToolboxEvents.mockImplementation(async (callback) => {
    order.push("listen");
    modules.snapshotListener = callback;
    return () => undefined;
  });
  modules.getToolboxSnapshot.mockImplementation(() => {
    order.push("read");
    return new Promise((resolve) => { resolveSnapshot = resolve; });
  });

  render(<ToolboxPanel />);
  await waitFor(() => expect(order).toEqual(["listen", "read"]));

  act(() => modules.snapshotListener?.({
    type: "snapshot",
    snapshot: toolboxSnapshot({ "keyboard-cleaning": unavailable("旧服务事件不能成为基线。") }, "service-previous", 99),
  }));
  resolveSnapshot(toolboxSnapshot({}, "service-current", 5));
  await waitFor(() => expect((screen.getByText("键盘清洁").closest("button") as HTMLButtonElement).disabled).toBe(false));

  act(() => modules.snapshotListener?.({
    type: "snapshot",
    snapshot: toolboxSnapshot({ "keyboard-cleaning": unavailable("当前服务事件已更新。") }, "service-current", 6),
  }));
  await waitFor(() => expect((screen.getByText("键盘清洁").closest("button") as HTMLButtonElement).disabled).toBe(true));

  act(() => modules.snapshotListener?.({ type: "snapshot", snapshot: toolboxSnapshot({}, "service-previous", 100) }));
  expect((screen.getByText("键盘清洁").closest("button") as HTMLButtonElement).disabled).toBe(true);

  act(() => modules.snapshotListener?.({ type: "snapshot", snapshot: toolboxSnapshot({}, "service-current", 7) }));
  await waitFor(() => expect((screen.getByText("键盘清洁").closest("button") as HTMLButtonElement).disabled).toBe(false));
});

it("routes URL decoding through the bounded decoder", async () => {
  render(<ToolboxPanel />);
  fireEvent.click(screen.getByText("URL").closest("button")!);
  fireEvent.change(screen.getByPlaceholderText("https://example.test/path?a=1&a=two+words"), { target: { value: "%" } });
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "decode" } });
  fireEvent.click(screen.getByRole("button", { name: "运行" }));

  expect((await screen.findByRole("alert")).textContent).toContain("百分号编码无效");
});

it("routes ISO-like dates through the strict time converter", async () => {
  render(<ToolboxPanel />);
  fireEvent.click(screen.getByText("时间转换").closest("button")!);
  fireEvent.change(screen.getByPlaceholderText("Unix 时间或带时区的 ISO 时间"), { target: { value: "2026-02-31Z" } });
  fireEvent.click(screen.getByRole("button", { name: "转换" }));

  expect((await screen.findByRole("alert")).textContent).toContain("ISO 日期无效");
});

it("loads further history pages with the opaque cursor and keeps the first page", async () => {
  const first = historyPage([historyRecord("first", "keep-awake")], "cursor-2", 7);
  const second = historyPage([historyRecord("second", "process-watch")], null, 7);
  modules.listToolboxHistory.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

  render(<ToolboxPanel />);
  await screen.findByText("history.tools.keep-awake");
  fireEvent.click(screen.getByRole("button", { name: "再显示 20 条" }));

  await waitFor(() => expect(modules.listToolboxHistory).toHaveBeenNthCalledWith(2, { limit: 20, cursor: "cursor-2" }));
  expect(await screen.findByText("history.tools.process-watch")).toBeTruthy();
  expect(screen.getByText("history.tools.keep-awake")).toBeTruthy();
});

it("compares the text SHA-256 output with an expected digest", async () => {
  const digest = hexBytes("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad").buffer;
  vi.spyOn(crypto.subtle, "digest").mockResolvedValue(digest as ArrayBuffer);

  render(<ToolboxPanel />);
  fireEvent.click(screen.getByText("文本 SHA-256").closest("button")!);
  fireEvent.change(screen.getByPlaceholderText("输入文本"), { target: { value: "abc" } });
  fireEvent.change(screen.getByRole("textbox", { name: "期望摘要" }), { target: { value: "BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD" } });
  fireEvent.click(screen.getByRole("button", { name: "计算 SHA-256" }));

  await waitFor(() => expect(screen.getByRole("status").getAttribute("data-comparison")).toBe("match"));
});

it("accepts any explicit keep-awake duration from 1 through 720 minutes", async () => {
  render(<ToolboxPanel />);
  fireEvent.click(screen.getByText("限时保活").closest("button")!);
  const duration = screen.getByRole("spinbutton", { name: "时长" });
  fireEvent.change(duration, { target: { value: "17" } });
  fireEvent.click(screen.getByRole("button", { name: "开始保活" }));

  await waitFor(() => expect(modules.startToolboxKeepAwake).toHaveBeenCalledWith(expect.objectContaining({ durationMinutes: 17 })));
});

function unavailable(reason: string) {
  return { state: "unavailable" as const, reason, platform: "macOS" };
}

function toolboxSnapshot(capabilities: Record<string, unknown> = {}, serviceInstanceId = "service-a", revision = 0) {
  return { capabilities, serviceInstanceId, revision };
}

function historyPage(records: ReturnType<typeof historyRecord>[] = [], nextCursor: string | null = null, historyRevision = 1) {
  return { records, nextCursor, historyRevision };
}

function historyRecord(recordId: string, tool: "keep-awake" | "process-watch") {
  return { recordId, tool, completedAtMs: 0, startedAtMs: 0, terminalStatus: "completed", notificationStatus: "submitted" };
}

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g)!.map((byte) => Number.parseInt(byte, 16)));
}
