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

import i18n from "../../i18n";

export const IMAGE_OPERATION_DEADLINE_MS = 30_000;
export const IMAGE_FONT_MAX_BYTES = 4 * 1024 * 1024;
const IMAGE_FONT_RESOURCE_KEY = "corerobinFonts";

type WorkerMessage =
  | { type: "result"; taskId: string; value: unknown }
  | { type: "error"; taskId: string; code: ImageWorkerErrorCode; message: string };

type ImageWorkerErrorCode = "unsupported" | "invalid_input" | "execution_failed";
type ImageSourceLabel = "input" | "background" | "logo";

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
  if (typeof Worker !== "function") return { supported: false, reason: imageError("dedicatedWorkerUnavailable").message };
  if (typeof OffscreenCanvas !== "function") return { supported: false, reason: imageError("offscreenCanvasUnavailable").message };
  if (typeof createImageBitmap !== "function") return { supported: false, reason: imageError("workerImageDecodeUnavailable").message };
  return { supported: true, reason: null };
}

export function createImageExecutionAdapter(options: ImageExecutionAdapterOptions = {}): WebMarkerExecutionAdapter {
  const availability = options.availability ?? getImageExecutionAvailability();
  const createWorker = options.createWorker ?? (() => new Worker(new URL("./image-execution.worker.ts", import.meta.url), { type: "module" }));
  const deadlineMs = options.deadlineMs ?? IMAGE_OPERATION_DEADLINE_MS;

  return {
    start<Result = unknown>(request: WebMarkerExecutionRequest): WebMarkerExecutionTask<Result> {
      if (!availability.supported) return rejectedExecutionTask<Result>(new Error(availability.reason ?? imageError("executorUnavailable").message));

      try {
        assertExecutionInput(request);
      } catch (error) {
        return rejectedExecutionTask<Result>(error instanceof Error ? error : imageError("invalidExecutionInput"));
      }

      let worker: ImageExecutionWorker;
      try {
        worker = createWorker();
      } catch {
        return rejectedExecutionTask<Result>(imageError("workerStartFailed"));
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
        fail(imageWorkerError(message.code));
      };
      worker.onerror = () => fail(imageError("workerExited"));
      worker.onmessageerror = () => fail(imageError("workerInvalidResult"));

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
      } catch {
        fail(imageError("workerRequestFailed"));
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
  if (!availability.supported) return Promise.reject(new Error(availability.reason ?? imageError("executorUnavailable").message));
  validateImageTransform(source, request);
  if (signal.aborted) return Promise.reject(createImageTransformAbortError());

  let worker: ImageExecutionWorker;
  try {
    worker = (options.createWorker ?? (() => new Worker(new URL("./image-execution.worker.ts", import.meta.url), { type: "module" })))();
  } catch {
    return Promise.reject(imageError("transformWorkerStartFailed"));
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
      fail(imageError("transformFailed"));
    }
  };
  worker.onerror = () => fail(imageError("transformWorkerExited"));
  worker.onmessageerror = () => fail(imageError("transformWorkerInvalidResult"));
  signal.addEventListener("abort", abort, { once: true });
  if (deadlineMs > 0) timeout = setTimeout(() => fail(imageError("transformDeadlineExceeded")), deadlineMs);

  try {
    worker.postMessage({ type: "transform", taskId, source, ...request });
  } catch {
    fail(imageError("transformWorkerRequestFailed"));
  }
  return result;
}

/**
 * The signal is a control-plane input only; it is never serialized into the
 * Worker. Aborting it terminates the transform Worker before the result settles.
 */
export function createImageTransformAbortError(): Error {
  const error = imageError("transformCancelled");
  error.name = "AbortError";
  return error;
}

function validateImageTransform(source: Blob, request: ImageTransformRequest): void {
  if (!(source instanceof Blob) || source.size > 12 * 1024 * 1024) throw imageError("transformInputInvalid");
  if (request.mode === "jpeg-quality") {
    const quality = request.quality;
    if (typeof quality !== "number" || !Number.isInteger(quality) || quality < 1 || quality > 100) throw imageError("jpegQualityInvalid");
    return;
  }
  if (request.mode === "scale") {
    if (typeof request.scale !== "number" || !Number.isFinite(request.scale) || request.scale <= 0 || request.scale > 1) throw imageError("scaleInvalid");
    return;
  }
  if (typeof request.cropRatio !== "number" || !Number.isFinite(request.cropRatio) || request.cropRatio < 0 || request.cropRatio > 0.2) throw imageError("cropInvalid");
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
      if (source.size > 12 * 1024 * 1024) throw imageError("imageTooLarge", { maxMiB: 12 });
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
    assertLocalSource(options, "input");
    return;
  }
  if (!options || typeof options !== "object") throw imageError("invalidExecutionInput");
  const record = options as Record<string, unknown>;
  if (request.operation === "embedInvisible" || request.operation === "detectInvisible") {
    assertLocalSource(readSource(record.image), "input");
    return;
  }
  assertLocalSource(readSource(record.backgroundImage), "background");
  const watermarkImages = record.watermarkImages;
  if (Array.isArray(watermarkImages)) {
    for (const watermark of watermarkImages) assertLocalSource(readSource(watermark), "logo");
  }
  const watermarks = record.watermarks;
  if (Array.isArray(watermarks)) {
    for (const watermark of watermarks) {
      if (watermark && typeof watermark === "object" && (watermark as { type?: unknown }).type === "image") {
        assertLocalSource(readSource(watermark), "logo");
      }
    }
  }
  const fonts = record[IMAGE_FONT_RESOURCE_KEY];
  if (fonts !== undefined) {
    if (!Array.isArray(fonts)) throw imageError("localFontInvalid");
    for (const font of fonts) assertLocalFont(font);
  }
}

function readSource(value: unknown): unknown {
  if (!value || typeof value !== "object") return undefined;
  return (value as Record<string, unknown>).src;
}

function assertLocalSource(source: unknown, label: ImageSourceLabel): void {
  if (source instanceof Blob) {
    if (source.size > 12 * 1024 * 1024) throw imageError("localSourceTooLarge", { label: imageSourceLabel(label), maxMiB: 12 });
    return;
  }
  if (typeof source === "string" && /^data:image\/(?:png|jpeg|webp);base64,/iu.test(source)) return;
  throw imageError("localSourceInvalid", { label: imageSourceLabel(label) });
}

function assertLocalFont(value: unknown): asserts value is LocalImageFontResource {
  if (!value || typeof value !== "object") throw imageError("localFontInvalid");
  const font = value as Partial<LocalImageFontResource>;
  if (typeof font.family !== "string" || !font.family.trim() || font.family.length > 120) throw imageError("localFontNameInvalid");
  if (!(font.source instanceof Blob) || font.source.size === 0 || font.source.size > IMAGE_FONT_MAX_BYTES) {
    throw imageError("localFontTooLarge", { maxMiB: Math.round(IMAGE_FONT_MAX_BYTES / 1024 / 1024) });
  }
}

function sanitizeExecutionOptions(value: unknown): unknown {
  if (value instanceof Blob || value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(sanitizeExecutionOptions);
  if (!value || typeof value !== "object") throw imageError("executionOptionsUnsafe");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw imageError("executionOptionsNonPlain");
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    // AbortSignal and observer callbacks are intentionally represented by the
    // SDK host task lifecycle, never serialized into a Worker or Rust DTO.
    if (key === "signal" || key === "onProgress" || key === "worker") continue;
    if (typeof nested === "function") throw imageError("executionOptionsCallbacks");
    result[key] = sanitizeExecutionOptions(nested);
  }
  return result;
}

function createExecutionAbortError(reason: WebMarkerExecutionTermination["reason"]): Error {
  const error = imageError(reason === "timeout" ? "executionDeadlineExceeded" : "executorTerminated");
  error.name = "AbortError";
  return error;
}

function imageWorkerError(code: ImageWorkerErrorCode): Error {
  if (code === "unsupported") return imageError("workerUnsupported");
  if (code === "invalid_input") return imageError("workerInvalidInput");
  return imageError("workerExecutionFailed");
}

function imageSourceLabel(label: ImageSourceLabel): string {
  return i18n.t(`toolbox:image.errors.labels.${label}`);
}

function imageError(key: string, options?: Record<string, unknown>): Error {
  return new Error(i18n.t(`toolbox:image.errors.${key}` as never, options));
}
