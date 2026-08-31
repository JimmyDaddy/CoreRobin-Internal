/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";

const mocks = vi.hoisted(() => ({
  cancel: vi.fn(),
  createBrowserInputs: vi.fn(),
  createObjectUrl: vi.fn(() => "blob:zip"),
  createRuntime: vi.fn(),
  detectInvisible: vi.fn(),
  embedInvisible: vi.fn(),
  getImageInfo: vi.fn(),
  mark: vi.fn(),
  transformImage: vi.fn(),
}));

vi.mock("@image-marker/web", () => ({
  ImageFormat: { png: "png", jpg: "jpg", webp: "webp" },
  Position: {
    topLeft: "topLeft", topCenter: "topCenter", topRight: "topRight", center: "center",
    bottomLeft: "bottomLeft", bottomCenter: "bottomCenter", bottomRight: "bottomRight",
  },
}));
vi.mock("../../api", () => ({ isDesktopRuntime: () => false }));
vi.mock("../client", () => ({
  cancelToolboxJob: vi.fn(),
  cancelToolboxOutput: vi.fn(),
  exportToolboxOutput: vi.fn(),
  finishToolboxJob: vi.fn(),
  newToolboxRequest: () => ({ requestId: "request" }),
  prepareToolboxInputs: vi.fn(),
  registerToolboxOutput: vi.fn(),
  releaseToolboxInputs: vi.fn(),
  revalidateToolboxInputs: vi.fn(),
  startToolboxSession: vi.fn(),
}));
vi.mock("../runtime/files", () => ({
  fileJobKey: vi.fn(),
  readBoundToolboxInput: vi.fn(),
}));
vi.mock("./ImageRecipeEditor", () => ({ ImageRecipeEditor: () => null }));
vi.mock("./imageExecution", () => ({
  createImageToolRuntime: mocks.createRuntime,
  IMAGE_FONT_MAX_BYTES: 4 * 1024 * 1024,
  IMAGE_OPERATION_DEADLINE_MS: 30_000,
  transformImageInWorker: mocks.transformImage,
  withLocalImageFonts: (options: unknown) => options,
}));
vi.mock("./imageInputs", () => ({ createBrowserImageInputs: mocks.createBrowserInputs, createNativeImageInputs: vi.fn() }));

import { ImageToolbox } from "./ImageToolbox";

class FakeZipWorker {
  static instances: FakeZipWorker[] = [];
  static acknowledgeAppendsByDefault = true;

  readonly postMessage = vi.fn((...args: [message: { type: string; id?: number }, transfer?: Transferable[]]) => {
    const [message] = args;
    if (message.type === "append" && this.acknowledgeAppends) {
      queueMicrotask(() => this.onmessage?.({ data: { type: "appended", id: message.id } } as MessageEvent<unknown>));
    }
    if (message.type === "finish") {
      queueMicrotask(() => this.onmessage?.({ data: { type: "complete", blob: new Blob(["zip"], { type: "application/zip" }) } } as MessageEvent<unknown>));
    }
  });
  readonly terminate = vi.fn();
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  acknowledgeAppends = FakeZipWorker.acknowledgeAppendsByDefault;

  constructor() {
    FakeZipWorker.instances.push(this);
  }
}

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
  vi.clearAllMocks();
  FakeZipWorker.instances = [];
  FakeZipWorker.acknowledgeAppendsByDefault = true;
  vi.stubGlobal("Worker", FakeZipWorker);
  class TestUrl extends globalThis.URL {
    static createObjectURL = mocks.createObjectUrl;
    static revokeObjectURL = vi.fn();
  }
  vi.stubGlobal("URL", TestUrl);
  mocks.getImageInfo.mockResolvedValue({ width: 2, height: 2 });
  mocks.mark.mockImplementation(async ({ backgroundImage }: { backgroundImage: { src: File } }) => ({
    uri: "data:image/png;base64,AQID",
    filename: backgroundImage.src.name,
    format: "png",
    durationMs: 1,
    metadata: { policy: "stripped" },
  }));
  mocks.embedInvisible.mockResolvedValue({
    uri: "data:image/png;base64,AQID",
    filename: "delivery.png",
    format: "png",
    durationMs: 1,
    metadata: { policy: "stripped" },
  });
  mocks.detectInvisible.mockResolvedValue({ detected: true, confidence: 0.91, scale: 1, algorithm: "dct-qim-v1" });
  mocks.transformImage.mockResolvedValue(new Blob(["transformed"], { type: "image/png" }));
  mocks.cancel.mockResolvedValue(undefined);
  mocks.createRuntime.mockReturnValue({
    marker: {
      capabilities: { execution: { mode: "host-adapter", supportsTerminationAcknowledgement: true } },
      cancel: mocks.cancel,
      detectInvisible: mocks.detectInvisible,
      embedInvisible: mocks.embedInvisible,
      getImageInfo: mocks.getImageInfo,
      mark: mocks.mark,
    },
    execution: { supported: true, reason: null },
    dispose: vi.fn(),
    editorAdapter: {},
  });
  mocks.createBrowserInputs.mockImplementation((_marker: unknown, files: File[]) => ({
    count: files.length,
    read: async (index: number) => files[index]!,
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function selectBatchFiles(container: HTMLElement, names = ["first.png", "second.png"]): Promise<void> {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("找不到图片输入控件。");
  const files = names.map((name) => new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" }));
  fireEvent.change(input, { target: { files } });
  await screen.findByText(new RegExp(`已选 ${files.length} 张`));
}

describe("batch image ZIP delivery", () => {
  it("transfers each completed watermark to the ZIP Worker before processing the next item", async () => {
    const view = render(<ImageToolbox toolId="image-batch-watermark" />);
    await selectBatchFiles(view.container);

    fireEvent.click(screen.getByRole("button", { name: "批量处理并打包" }));
    await screen.findByRole("link", { name: "下载预览 ZIP（非正式导出）" });

    const worker = FakeZipWorker.instances[0]!;
    const calls = worker.postMessage.mock.calls;
    const appendCalls = calls.filter(([message]) => (message as { type: string }).type === "append");
    expect(calls[0]?.[0]).toEqual({ type: "start", maxOutputFiles: 20 });
    expect(appendCalls).toHaveLength(2);
    expect(appendCalls.map(([message]) => (message as { id: number }).id)).toEqual([1, 2]);
    for (const [message, transfer] of appendCalls) {
      expect(transfer).toEqual([(message as unknown as { item: { bytes: ArrayBuffer } }).item.bytes]);
    }
    expect(calls[calls.length - 1]?.[0]).toEqual({ type: "finish" });
    expect(mocks.mark).toHaveBeenCalledTimes(2);
  });

  it("terminates the ZIP Worker and rejects its pending item when the user stops", async () => {
    const view = render(<ImageToolbox toolId="image-batch-watermark" />);
    await selectBatchFiles(view.container, ["first.png"]);
    FakeZipWorker.acknowledgeAppendsByDefault = false;
    fireEvent.click(screen.getByRole("button", { name: "批量处理并打包" }));

    await waitFor(() => expect(FakeZipWorker.instances[0]?.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "append", id: 1 }), expect.any(Array)));
    const worker = FakeZipWorker.instances[0]!;
    fireEvent.click(screen.getByRole("button", { name: "停止" }));

    await screen.findByText(/图片处理已取消/);
    expect(mocks.cancel).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("uses the same per-item transfer protocol for 30-file recipient delivery", async () => {
    const prompt = vi.spyOn(window, "prompt")
      .mockReturnValueOnce("recipient-a,recipient-b")
      .mockReturnValueOnce("one-time-recipient-key");
    const view = render(<ImageToolbox toolId="recipient-tracking" />);
    await selectBatchFiles(view.container, ["source.png"]);

    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "生成分发样本" }));
    await screen.findByRole("link", { name: "下载预览 ZIP（非正式导出）" });

    const worker = FakeZipWorker.instances[0]!;
    const appendCalls = worker.postMessage.mock.calls.filter(([message]) => (message as { type: string }).type === "append");
    expect(worker.postMessage.mock.calls[0]?.[0]).toEqual({ type: "start", maxOutputFiles: 30 });
    expect(appendCalls.map(([message]) => (message as unknown as { item: { name: string } }).item.name)).toEqual(["delivery-01.png", "delivery-02.png"]);
    expect(mocks.embedInvisible).toHaveBeenCalledTimes(2);
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it("runs each declared robustness sample and shows a bounded report", async () => {
    const view = render(<ImageToolbox toolId="robustness-lab" />);
    await selectBatchFiles(view.container, ["source.png"]);

    fireEvent.click(screen.getByRole("button", { name: "生成实验样本" }));
    await screen.findAllByText(/jpeg-quality-75/);

    expect(mocks.embedInvisible).toHaveBeenCalledOnce();
    expect(mocks.transformImage).toHaveBeenCalledTimes(4);
    expect(mocks.transformImage.mock.calls.map(([, request]) => request.mode)).toEqual(["jpeg-quality", "jpeg-quality", "scale", "crop"]);
    expect(mocks.detectInvisible).toHaveBeenCalledTimes(5);
    expect(screen.getAllByText(/original/)).not.toHaveLength(0);
    expect(screen.getAllByText(/jpeg-quality-95/)).not.toHaveLength(0);
    expect(screen.getAllByText(/scale-95-percent/)).not.toHaveLength(0);
    expect(screen.getAllByText(/limited-crop-4-percent/)).not.toHaveLength(0);
  });
});
