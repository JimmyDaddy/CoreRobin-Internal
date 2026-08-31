import { describe, expect, it, vi } from "vitest";
import type { WebMarkerExecutionRequest } from "@image-marker/web";

import { createImageExecutionAdapter, createImageToolRuntime, transformImageInWorker, withLocalImageFonts } from "./imageExecution";

class FakeImageWorker {
  readonly postMessage = vi.fn();
  readonly terminate = vi.fn();
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;

  emit(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent<unknown>);
  }
}

const supported = { supported: true, reason: null } as const;

function markTextRequest(taskId = "task-1"): WebMarkerExecutionRequest {
  return {
    taskId,
    operation: "markText",
    resultKind: "marker-result",
    options: {
      backgroundImage: { src: new Blob(["image"], { type: "image/png" }) },
      watermarkTexts: [{ text: "CoreRobin" }],
    },
    signal: new AbortController().signal,
  } as WebMarkerExecutionRequest;
}

describe("isolated image execution adapter", () => {
  it("uses a task-owned Worker and never transfers AbortSignal or callbacks", async () => {
    const worker = new FakeImageWorker();
    const adapter = createImageExecutionAdapter({ availability: supported, createWorker: () => worker });
    const task = adapter.start<{ uri: string }>(markTextRequest());

    expect(worker.postMessage).toHaveBeenCalledOnce();
    expect(worker.postMessage.mock.calls[0]?.[0]).toMatchObject({ type: "execute", taskId: "task-1", operation: "markText" });
    expect(worker.postMessage.mock.calls[0]?.[0]).not.toHaveProperty("signal");

    worker.emit({ type: "result", taskId: "task-1", value: { uri: "data:image/png;base64,AA==" } });
    await expect(task.result).resolves.toEqual({ uri: "data:image/png;base64,AA==" });
    await task.dispose?.();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("terminates before rejecting, rejects late output, and keeps dispose idempotent", async () => {
    const worker = new FakeImageWorker();
    const adapter = createImageExecutionAdapter({ availability: supported, createWorker: () => worker });
    const task = adapter.start<{ uri: string }>(markTextRequest("task-2"));

    await task.terminate?.({ reason: "cancel", taskId: "task-2" });
    await expect(task.result).rejects.toMatchObject({ name: "AbortError" });
    worker.emit({ type: "result", taskId: "task-2", value: { uri: "late-result" } });
    await task.dispose?.();
    await task.dispose?.();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("rejects remote sources before a Worker can be started", async () => {
    const createWorker = vi.fn(() => new FakeImageWorker());
    const adapter = createImageExecutionAdapter({ availability: supported, createWorker });
    const task = adapter.start({
      ...markTextRequest("task-3"),
      options: { backgroundImage: { src: "https://example.invalid/image.png" }, watermarkTexts: [{ text: "x" }] },
    } as WebMarkerExecutionRequest);

    await expect(task.result).rejects.toThrow("本地文件");
    expect(createWorker).not.toHaveBeenCalled();
  });

  it("keeps local font bytes inside the task Worker and rejects remote image layers", async () => {
    const worker = new FakeImageWorker();
    const adapter = createImageExecutionAdapter({ availability: supported, createWorker: () => worker });
    const task = adapter.start({
      ...markTextRequest("task-font"),
      operation: "mark",
      options: withLocalImageFonts({
        backgroundImage: { src: new Blob(["image"], { type: "image/png" }) },
        watermarks: [{ type: "text", text: "字体测试" }],
      }, [{ family: "LocalFont", source: new Blob(["font"], { type: "font/woff2" }) }]),
    } as WebMarkerExecutionRequest);

    const options = worker.postMessage.mock.calls[0]?.[0] as { options: { corerobinFonts?: unknown } };
    expect(options.options.corerobinFonts).toHaveLength(1);
    await task.terminate?.({ reason: "cancel", taskId: "task-font" });
    await expect(task.result).rejects.toMatchObject({ name: "AbortError" });

    const rejected = adapter.start({
      ...markTextRequest("task-remote-layer"),
      operation: "mark",
      options: {
        backgroundImage: { src: new Blob(["image"], { type: "image/png" }) },
        watermarks: [{ type: "image", src: "https://example.invalid/logo.png" }],
      },
    } as WebMarkerExecutionRequest);
    await expect(rejected.result).rejects.toThrow("Logo 图片");
  });

  it("keeps SDK-generated undefined recipe fields serializable", async () => {
    const worker = new FakeImageWorker();
    const adapter = createImageExecutionAdapter({ availability: supported, createWorker: () => worker });
    const task = adapter.start({
      ...markTextRequest("task-4"),
      operation: "mark",
      options: {
        backgroundImage: { src: new Blob(["image"], { type: "image/png" }) },
        watermarkTexts: [{ text: "recipe" }],
        quality: undefined,
      },
    } as WebMarkerExecutionRequest);

    expect(worker.postMessage).toHaveBeenCalledOnce();
    await task.terminate?.({ reason: "cancel", taskId: "task-4" });
    await expect(task.result).rejects.toMatchObject({ name: "AbortError" });
  });

  it("routes the public marker instance through the adapter shared with the editor", async () => {
    const workers: FakeImageWorker[] = [];
    const runtime = createImageToolRuntime({
      availability: supported,
      createWorker: () => {
        const worker = new FakeImageWorker();
        workers.push(worker);
        return worker;
      },
    });
    const result = runtime.marker.markText({
      backgroundImage: { src: new Blob(["image"], { type: "image/png" }) },
      watermarkTexts: [{ text: "CoreRobin" }],
    });

    expect(runtime.marker.capabilities.execution).toMatchObject({ mode: "host-adapter", supportsTerminationAcknowledgement: true });
    expect(runtime.editorAdapter).toBeDefined();
    expect(workers).toHaveLength(1);
    const message = workers[0]?.postMessage.mock.calls[0]?.[0] as { taskId: string };
    workers[0]?.emit({ type: "result", taskId: message.taskId, value: { uri: "data:image/png;base64,AA==" } });
    await expect(result).resolves.toMatchObject({ uri: "data:image/png;base64,AA==" });
    await runtime.dispose();
  });

  it("runs robustness transforms in a task-owned Worker and releases it after output", async () => {
    const worker = new FakeImageWorker();
    const result = transformImageInWorker(
      new Blob(["image"], { type: "image/png" }),
      { mode: "scale", scale: 0.95 },
      new AbortController().signal,
      { availability: supported, createWorker: () => worker },
    );
    const message = worker.postMessage.mock.calls[0]?.[0] as { taskId: string; type: string; signal?: unknown };
    expect(message).toMatchObject({ type: "transform", mode: "scale", scale: 0.95 });
    expect(message.signal).toBeUndefined();
    worker.emit({ type: "transform-result", taskId: message.taskId, blob: new Blob(["result"], { type: "image/png" }) });
    await expect(result).resolves.toBeInstanceOf(Blob);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("terminates a robustness transform when its control signal aborts", async () => {
    const worker = new FakeImageWorker();
    const controller = new AbortController();
    const result = transformImageInWorker(
      new Blob(["image"], { type: "image/png" }),
      { mode: "jpeg-quality", quality: 75 },
      controller.signal,
      { availability: supported, createWorker: () => worker },
    );
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
