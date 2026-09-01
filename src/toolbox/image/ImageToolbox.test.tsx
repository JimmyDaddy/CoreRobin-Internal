/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";

const mocks = vi.hoisted(() => ({
  cancel: vi.fn(),
  cancelJob: vi.fn(),
  createBrowserInputs: vi.fn(),
  createNativeInputs: vi.fn(),
  createObjectUrl: vi.fn(() => "blob:zip"),
  createRuntime: vi.fn(),
  desktopRuntime: false,
  detectInvisible: vi.fn(),
  embedInvisible: vi.fn(),
  getImageInfo: vi.fn(),
  mark: vi.fn(),
  finishJob: vi.fn(),
  prepareInputs: vi.fn(),
  registerOutput: vi.fn(),
  releaseInputs: vi.fn(),
  revalidateInputs: vi.fn(),
  startSession: vi.fn(),
  transformImage: vi.fn(),
}));

vi.mock("@image-marker/web", () => ({
  ImageFormat: { png: "png", jpg: "jpg", webp: "webp" },
  Position: {
    topLeft: "topLeft", topCenter: "topCenter", topRight: "topRight", center: "center",
    bottomLeft: "bottomLeft", bottomCenter: "bottomCenter", bottomRight: "bottomRight",
  },
}));
vi.mock("../../api", () => ({ isDesktopRuntime: () => mocks.desktopRuntime }));
vi.mock("../client", () => ({
  cancelToolboxJob: mocks.cancelJob,
  cancelToolboxOutput: vi.fn(),
  exportToolboxOutput: vi.fn(),
  finishToolboxJob: mocks.finishJob,
  newToolboxRequest: () => ({ requestId: "request" }),
  prepareToolboxInputs: mocks.prepareInputs,
  registerToolboxOutput: mocks.registerOutput,
  releaseToolboxInputs: mocks.releaseInputs,
  revalidateToolboxInputs: mocks.revalidateInputs,
  startToolboxSession: mocks.startSession,
}));
vi.mock("../runtime/files", () => ({
  fileJobKey: (job: { jobId: string; generation: number; resetEpoch: number }) => ({ jobId: job.jobId, generation: job.generation, resetEpoch: job.resetEpoch }),
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
vi.mock("./imageInputs", () => ({ createBrowserImageInputs: mocks.createBrowserInputs, createNativeImageInputs: mocks.createNativeInputs, imageMimeType: vi.fn(() => "application/octet-stream"), strictImageMimeType: vi.fn(() => "application/octet-stream") }));

import { ImageToolbox } from "./ImageToolbox";

class FakeZipWorker {
  static instances: FakeZipWorker[] = [];
  static acknowledgeAppendsByDefault = true;
  static errorCodeOnAppend: string | null = null;

  readonly postMessage = vi.fn((...args: [message: { type: string; id?: number }, transfer?: Transferable[]]) => {
    const [message] = args;
    if (message.type === "append" && FakeZipWorker.errorCodeOnAppend) {
      const code = FakeZipWorker.errorCodeOnAppend;
      queueMicrotask(() => this.onmessage?.({ data: { type: "error", code } } as MessageEvent<unknown>));
    } else if (message.type === "append" && this.acknowledgeAppends) {
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
  mocks.desktopRuntime = false;
  FakeZipWorker.instances = [];
  FakeZipWorker.acknowledgeAppendsByDefault = true;
  FakeZipWorker.errorCodeOnAppend = null;
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
  mocks.createNativeInputs.mockReturnValue({
    count: 1,
    read: async () => new File([new Uint8Array([1, 2, 3])], "native.png", { type: "image/png" }),
  });
  mocks.startSession.mockResolvedValue({ jobId: "job", sessionId: "session", generation: 1, resetEpoch: 3, status: "running", outputExpiresAtMs: null, outputToken: null, terminalReason: null, error: null });
  mocks.prepareInputs.mockResolvedValue([{ token: "input", displayName: "native.png", role: "input", byteLength: 3 }]);
  mocks.finishJob.mockResolvedValue({ jobId: "job", sessionId: "session", generation: 1, resetEpoch: 3, status: "failed", outputExpiresAtMs: null, outputToken: null, terminalReason: "failed", error: null });
  mocks.cancelJob.mockResolvedValue({ jobId: "job", sessionId: "session", generation: 1, resetEpoch: 3, status: "cancelled", outputExpiresAtMs: null, outputToken: null, terminalReason: "cancelled", error: null });
  mocks.releaseInputs.mockResolvedValue(undefined);
  mocks.revalidateInputs.mockResolvedValue(undefined);
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

describe("image toolbox presentation states", () => {
  it("communicates empty input, selected input, and the labelled preview result", async () => {
    const view = render(<ImageToolbox toolId="image-watermark" />);

    expect(screen.getByRole("status").textContent).toContain("没有选择图片输入");
    const inputStage = view.container.querySelector<HTMLElement>(".image-toolbox__input-stage");
    expect(inputStage?.getAttribute("data-has-input")).toBe("false");

    await selectBatchFiles(view.container, ["source.png"]);
    expect(inputStage?.getAttribute("data-has-input")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "添加文字水印" }));
    const preview = await screen.findByRole("region", { name: "结果" });
    expect(preview.querySelector(".image-toolbox__result-header")?.textContent).toContain("PNG");
    expect(preview.querySelector("img")?.getAttribute("alt")).toBe("本地水印结果预览");
  });

  it("does not report a second input release after a terminal native failure already released ownership", async () => {
    mocks.desktopRuntime = true;
    mocks.mark.mockRejectedValueOnce(new Error("image failed"));
    render(<ImageToolbox toolId="image-watermark" />);

    fireEvent.click(screen.getByRole("button", { name: "添加文字水印" }));

    await waitFor(() => expect(mocks.finishJob).toHaveBeenCalledOnce());
    expect(mocks.releaseInputs).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).not.toContain("输入资源释放未确认");
  });
});

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

  it("passes explicit text placement, rotation, outline, and tiled layout to the SDK", async () => {
    const view = render(<ImageToolbox toolId="image-watermark" />);
    await selectBatchFiles(view.container, ["source.png"]);

    fireEvent.change(screen.getByLabelText("位置"), { target: { value: "topLeft" } });
    fireEvent.change(screen.getByLabelText("字号"), { target: { value: "36" } });
    fireEvent.change(screen.getByLabelText("旋转"), { target: { value: "25" } });
    fireEvent.change(screen.getByLabelText("描边宽度"), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText("布局"), { target: { value: "tile" } });
    expect(screen.getByLabelText("位置")).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByRole("button", { name: "添加文字水印" }));
    await screen.findByRole("img");

    const options = mocks.mark.mock.calls[mocks.mark.mock.calls.length - 1]?.[0] as { watermarks: Array<{ position?: unknown; layout?: unknown; style?: Record<string, unknown> }> };
    expect(options.watermarks[0]).toMatchObject({
      layout: { type: "tile", gapX: 80, gapY: 80, stagger: true },
      style: { fontSize: 36, rotate: 25, strokeStyle: { color: "#00000099", width: 3 } },
    });
    expect(options.watermarks[0]?.position).toBeUndefined();
  });

  it("applies the selected confidential preset to the editable watermark", async () => {
    const view = render(<ImageToolbox toolId="confidential-watermark" />);
    await selectBatchFiles(view.container, ["source.png"]);

    fireEvent.change(screen.getByLabelText("保密预设"), { target: { value: "draft" } });
    expect((screen.getByLabelText("文字") as HTMLInputElement).value).toBe("DRAFT · DO NOT DISTRIBUTE");
    fireEvent.click(screen.getByRole("button", { name: "添加文字水印" }));
    await screen.findByRole("img");

    const options = mocks.mark.mock.calls[mocks.mark.mock.calls.length - 1]?.[0] as { watermarks: Array<{ text: string; alpha: number; style?: { color?: string } }> };
    expect(options.watermarks[0]).toMatchObject({ text: "DRAFT · DO NOT DISTRIBUTE", alpha: 0.6, style: { color: "#ff6b6b" } });
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

  it("localizes stable ZIP Worker error codes before showing them in the UI", async () => {
    FakeZipWorker.errorCodeOnAppend = "zip_input_budget_exceeded";
    const view = render(<ImageToolbox toolId="image-batch-watermark" />);
    await selectBatchFiles(view.container, ["first.png"]);

    fireEvent.click(screen.getByRole("button", { name: "批量处理并打包" }));

    await screen.findByText("合计输入大小超过 80 MiB 上限。");
    expect(screen.queryByText("zip_input_budget_exceeded")).toBeNull();
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
