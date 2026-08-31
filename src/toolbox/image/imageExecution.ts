import {
  createWebMarker,
  type WebMarkerExecutionAdapter,
  type WebMarkerExecutionRequest,
  type WebMarkerExecutionTask,
  type WebMarkerExecutionTermination,
  type WebMarkerInstance,
  type WebResourceAdapter,
} from "@image-marker/web";
import { createWebEditorAdapter } from "@image-marker/web/editor-adapter";
import type { ImageMarkerEditorRenderAdapter } from "@image-marker/web/headless";

export const IMAGE_OPERATION_DEADLINE_MS = 30_000;
export const IMAGE_FONT_MAX_BYTES = 4 * 1024 * 1024;
const IMAGE_FONT_RESOURCE_KEY = "corerobinFonts";

type WorkerMessage =
  | { type: "result"; taskId: string; value: unknown }
  | { type: "error"; taskId: string; code: "unsupported" | "invalid_input" | "execution_failed"; message: string };

interface ImageExecutionWorker extends Pick<Worker, "postMessage" | "terminate"> {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
}

export type ImageTransformMode = "jpeg-quality" | "scale" | "crop";

export interface ImageTransformRequest {
  mode: ImageTransformMode;
  quality?: number;
  scale?: number;
  cropRatio?: number;
}

export interface ImageTransformAdapterOptions extends Pick<ImageExecutionAdapterOptions, "createWorker" | "availability"> {
  deadlineMs?: number;
}

export interface ImageExecutionAvailability {
  supported: boolean;
  reason: string | null;
}

export interface ImageExecutionAdapterOptions {
  createWorker?: () => ImageExecutionWorker;
  availability?: ImageExecutionAvailability;
  deadlineMs?: number;
}

export interface LocalImageFontResource {
  family: string;
  source: Blob;
}

/** Attach explicitly selected font bytes to one isolated task, never to IPC. */
export function withLocalImageFonts<Options extends object>(options: Options, fonts: readonly LocalImageFontResource[]): Options {
  if (fonts.length === 0) return options;
  for (const font of fonts) assertLocalFont(font);
  return { ...options, [IMAGE_FONT_RESOURCE_KEY]: fonts };
}

export interface ImageToolRuntime {
  marker: WebMarkerInstance;
  editorAdapter: ImageMarkerEditorRenderAdapter;
  execution: ImageExecutionAvailability;
  dispose(): Promise<void>;
}

/**
 * The public Web SDK explicitly marks Canvas rendering as host-termination
 * required. A dedicated Worker is the execution unit: cancellation terminates
 * that unit before its task settles, instead of merely ignoring a Promise.
 */
export function getImageExecutionAvailability(): ImageExecutionAvailability {
  if (typeof Worker !== "function") return { supported: false, reason: "当前 WebView 不支持 Dedicated Worker。" };
  if (typeof OffscreenCanvas !== "function") return { supported: false, reason: "当前 WebView 不支持 OffscreenCanvas 隔离渲染。" };
  if (typeof createImageBitmap !== "function") return { supported: false, reason: "当前 WebView 不支持 Worker 内图片解码。" };
  return { supported: true, reason: null };
}

export function createImageExecutionAdapter(options: ImageExecutionAdapterOptions = {}): WebMarkerExecutionAdapter {
  const availability = options.availability ?? getImageExecutionAvailability();
  const createWorker = options.createWorker ?? (() => new Worker(new URL("./image-execution.worker.ts", import.meta.url), { type: "module" }));
  const deadlineMs = options.deadlineMs ?? IMAGE_OPERATION_DEADLINE_MS;

  return {
    start<Result = unknown>(request: WebMarkerExecutionRequest): WebMarkerExecutionTask<Result> {
      if (!availability.supported) return rejectedExecutionTask<Result>(new Error(availability.reason ?? "图片受限执行器不可用。"));

      try {
        assertExecutionInput(request);
      } catch (error) {
        return rejectedExecutionTask<Result>(error instanceof Error ? error : new Error("图片执行输入无效。"));
      }

      let worker: ImageExecutionWorker;
      try {
        worker = createWorker();
      } catch (error) {
        return rejectedExecutionTask<Result>(new Error(`图片执行 Worker 无法启动：${safeErrorMessage(error)}`));
      }

      let settled = false;
      let terminated = false;
      let workerReleased = false;
      let termination: Promise<void> | null = null;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      let resolveResult: (value: Result) => void = () => undefined;
      let rejectResult: (reason: Error) => void = () => undefined;

      const cleanupListeners = () => {
        if (timeout !== null) {
          clearTimeout(timeout);
          timeout = null;
        }
        worker.onmessage = null;
        worker.onerror = null;
        worker.onmessageerror = null;
      };

      const terminateWorker = () => {
        if (workerReleased) return;
        workerReleased = true;
        try {
          worker.terminate();
        } catch {
          // A terminated Worker has no additional application-owned resources.
        }
      };

      const result = new Promise<Result>((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
      });

      const fail = (reason: Error, terminate = true) => {
        if (settled) return;
        settled = true;
        cleanupListeners();
        if (terminate) terminateWorker();
        rejectResult(reason);
      };

      const terminate = (requestTermination: WebMarkerExecutionTermination): Promise<void> => {
        if (termination) return termination;
        terminated = true;
        termination = Promise.resolve().then(() => {
          // Worker.terminate() is the browser's force-stop primitive. Settling the
          // task only after it is called keeps the SDK cancel()/dispose() acknowledgement
          // coupled to the actual execution unit, not to a Promise race.
          terminateWorker();
          fail(createExecutionAbortError(requestTermination.reason), false);
        });
        return termination;
      };

      const dispose = async () => {
        if (settled) {
          cleanupListeners();
          terminateWorker();
          return;
        }
        await terminate({ reason: "dispose", taskId: request.taskId });
      };

      worker.onmessage = (event) => {
        const message = event.data as WorkerMessage;
        if (settled || terminated || message.taskId !== request.taskId) return;
        if (message.type === "result") {
          settled = true;
          cleanupListeners();
          resolveResult(message.value as Result);
          return;
        }
        fail(new Error(message.message));
      };
      worker.onerror = () => fail(new Error("图片受限执行 Worker 意外退出。"));
      worker.onmessageerror = () => fail(new Error("图片受限执行 Worker 返回了无效结果。"));

      if (deadlineMs > 0) {
        timeout = setTimeout(() => {
          void terminate({ reason: "timeout", taskId: request.taskId });
        }, deadlineMs);
      }

      try {
        worker.postMessage({
          type: "execute",
          taskId: request.taskId,
          operation: request.operation,
          resultKind: request.resultKind,
          options: sanitizeExecutionOptions(request.options),
        });
      } catch (error) {
        fail(new Error(`图片执行请求无法传入隔离 Worker：${safeErrorMessage(error)}`));
      }

      return { result, terminate, dispose };
    },
  };
}

/**
 * Run a bounded, non-SDK pixel transform in the same task-owned Worker model.
 * The robustness lab uses this for its declared JPEG/scale/crop cases; using a
 * second Worker keeps canvas operations out of the page while preserving a
 * real terminate acknowledgement for cancellation.
 */
export function transformImageInWorker(
  source: Blob,
  request: ImageTransformRequest,
  signal: AbortSignal,
  options: ImageTransformAdapterOptions = {},
): Promise<Blob> {
  const availability = options.availability ?? getImageExecutionAvailability();
  if (!availability.supported) return Promise.reject(new Error(availability.reason ?? "图片受限执行器不可用。"));
  validateImageTransform(source, request);
  if (signal.aborted) return Promise.reject(createImageTransformAbortError());

  let worker: ImageExecutionWorker;
  try {
    worker = (options.createWorker ?? (() => new Worker(new URL("./image-execution.worker.ts", import.meta.url), { type: "module" })))();
  } catch (error) {
    return Promise.reject(new Error(`图片变换 Worker 无法启动：${safeErrorMessage(error)}`));
  }

  const taskId = crypto.randomUUID();
  const deadlineMs = options.deadlineMs ?? 60_000;
  let settled = false;
  let released = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let resolveResult: (value: Blob) => void = () => undefined;
  let rejectResult: (reason: Error) => void = () => undefined;
  const result = new Promise<Blob>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const releaseWorker = () => {
    if (released) return;
    released = true;
    try {
      worker.terminate();
    } catch {
      // A terminated transform Worker has no additional application-owned resources.
    }
  };
  const cleanup = () => {
    if (timeout !== null) {
      clearTimeout(timeout);
      timeout = null;
    }
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    signal.removeEventListener("abort", abort);
  };
  const fail = (reason: Error) => {
    if (settled) return;
    settled = true;
    cleanup();
    releaseWorker();
    rejectResult(reason);
  };
  const finish = (value: Blob) => {
    if (settled) return;
    settled = true;
    cleanup();
    releaseWorker();
    resolveResult(value);
  };
  const abort = () => fail(createImageTransformAbortError());

  worker.onmessage = (event) => {
    const message = event.data as { type?: unknown; taskId?: unknown; blob?: unknown; error?: unknown };
    if (message.taskId !== taskId || settled) return;
    if (message.type === "transform-result" && message.blob instanceof Blob) {
      finish(message.blob);
    } else {
      fail(new Error(typeof message.error === "string" ? message.error : "图片变换失败。"));
    }
  };
  worker.onerror = () => fail(new Error("图片变换 Worker 意外退出。"));
  worker.onmessageerror = () => fail(new Error("图片变换 Worker 返回了无效结果。"));
  signal.addEventListener("abort", abort, { once: true });
  if (deadlineMs > 0) timeout = setTimeout(() => fail(new Error("图片稳健性样本超过单项 60 秒上限。")), deadlineMs);

  try {
    worker.postMessage({ type: "transform", taskId, source, ...request });
  } catch (error) {
    fail(new Error(`图片变换请求无法传入隔离 Worker：${safeErrorMessage(error)}`));
  }
  return result;
}

/**
 * The signal is a control-plane input only; it is never serialized into the
 * Worker. Aborting it terminates the transform Worker before the result settles.
 */
export function createImageTransformAbortError(): Error {
  const error = new Error("图片稳健性样本已停止。");
  error.name = "AbortError";
  return error;
}

function validateImageTransform(source: Blob, request: ImageTransformRequest): void {
  if (!(source instanceof Blob) || source.size > 12 * 1024 * 1024) throw new Error("图片变换输入必须是 12 MiB 以内的本地 Blob。");
  if (request.mode === "jpeg-quality") {
    const quality = request.quality;
    if (typeof quality !== "number" || !Number.isInteger(quality) || quality < 1 || quality > 100) throw new Error("JPEG 样本质量必须是 1 到 100 的整数。");
    return;
  }
  if (request.mode === "scale") {
    if (typeof request.scale !== "number" || !Number.isFinite(request.scale) || request.scale <= 0 || request.scale > 1) throw new Error("缩放样本比例必须大于 0 且不超过 1。");
    return;
  }
  if (typeof request.cropRatio !== "number" || !Number.isFinite(request.cropRatio) || request.cropRatio < 0 || request.cropRatio > 0.2) throw new Error("裁剪样本比例必须在 0 到 20% 之间。");
}

/**
 * Recipe and the headless editor adapter deliberately receive this same marker
 * instance. Neither may create a default DOM marker behind the host boundary.
 */
export function createImageToolRuntime(options: ImageExecutionAdapterOptions = {}): ImageToolRuntime {
  const execution = options.availability ?? getImageExecutionAvailability();
  const marker = createWebMarker({
    resources: createLocalResourceBoundary(),
    execution: createImageExecutionAdapter({ ...options, availability: execution }),
  });
  return {
    marker,
    editorAdapter: createWebEditorAdapter(1024, marker),
    execution,
    dispose: () => marker.dispose(),
  };
}

function createLocalResourceBoundary(): WebResourceAdapter {
  return {
    async readBlobBytes(source) {
      if (source.size > 12 * 1024 * 1024) throw new Error("图片不能超过 12 MiB。");
      return source.arrayBuffer();
    },
  };
}

function rejectedExecutionTask<Result>(error: Error): WebMarkerExecutionTask<Result> {
  return {
    result: Promise.reject(error),
    terminate: () => Promise.resolve(),
    dispose: () => Promise.resolve(),
  };
}

function assertExecutionInput(request: WebMarkerExecutionRequest): void {
  const options = request.options;
  if (request.operation === "getImageInfo") {
    assertLocalSource(options, "图片输入");
    return;
  }
  if (!options || typeof options !== "object") throw new Error("图片执行参数无效。");
  const record = options as Record<string, unknown>;
  if (request.operation === "embedInvisible" || request.operation === "detectInvisible") {
    assertLocalSource(readSource(record.image), "图片输入");
    return;
  }
  assertLocalSource(readSource(record.backgroundImage), "背景图片");
  const watermarkImages = record.watermarkImages;
  if (Array.isArray(watermarkImages)) {
    for (const watermark of watermarkImages) assertLocalSource(readSource(watermark), "Logo 图片");
  }
  const watermarks = record.watermarks;
  if (Array.isArray(watermarks)) {
    for (const watermark of watermarks) {
      if (watermark && typeof watermark === "object" && (watermark as { type?: unknown }).type === "image") {
        assertLocalSource(readSource(watermark), "Logo 图片");
      }
    }
  }
  const fonts = record[IMAGE_FONT_RESOURCE_KEY];
  if (fonts !== undefined) {
    if (!Array.isArray(fonts)) throw new Error("本地字体资源无效。");
    for (const font of fonts) assertLocalFont(font);
  }
}

function readSource(value: unknown): unknown {
  if (!value || typeof value !== "object") return undefined;
  return (value as Record<string, unknown>).src;
}

function assertLocalSource(source: unknown, label: string): void {
  if (source instanceof Blob) {
    if (source.size > 12 * 1024 * 1024) throw new Error(`${label}不能超过 12 MiB。`);
    return;
  }
  if (typeof source === "string" && /^data:image\/(?:png|jpeg|webp);base64,/iu.test(source)) return;
  throw new Error(`${label}必须是当前操作明确选择的 PNG、JPEG 或 WebP 本地文件。`);
}

function assertLocalFont(value: unknown): asserts value is LocalImageFontResource {
  if (!value || typeof value !== "object") throw new Error("本地字体资源无效。");
  const font = value as Partial<LocalImageFontResource>;
  if (typeof font.family !== "string" || !font.family.trim() || font.family.length > 120) throw new Error("本地字体名称无效。");
  if (!(font.source instanceof Blob) || font.source.size === 0 || font.source.size > IMAGE_FONT_MAX_BYTES) {
    throw new Error("本地字体必须是当前操作选择且不超过 4 MiB 的文件。");
  }
}

function sanitizeExecutionOptions(value: unknown): unknown {
  if (value instanceof Blob || value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(sanitizeExecutionOptions);
  if (!value || typeof value !== "object") throw new Error("图片执行参数无法安全传输。" );
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error("图片执行参数只能包含普通数据和本地 Blob。" );
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    // AbortSignal and observer callbacks are intentionally represented by the
    // SDK host task lifecycle, never serialized into a Worker or Rust DTO.
    if (key === "signal" || key === "onProgress" || key === "worker") continue;
    if (typeof nested === "function") throw new Error("图片执行参数不能包含回调函数。" );
    result[key] = sanitizeExecutionOptions(nested);
  }
  return result;
}

function createExecutionAbortError(reason: WebMarkerExecutionTermination["reason"]): Error {
  const error = new Error(reason === "timeout" ? "图片处理超过 30 秒执行上限，已终止隔离执行器。" : "图片隔离执行器已终止并释放资源。");
  error.name = "AbortError";
  return error;
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message.slice(0, 180) : "未知错误";
}
