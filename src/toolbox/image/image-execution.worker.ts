import { createWebMarker, type MarkerResult, type WebResourceAdapter } from "@image-marker/web";

type WorkerOperation = "getImageInfo" | "markText" | "markImage" | "mark" | "embedInvisible" | "detectInvisible";
type WorkerResultKind = "marker-result" | "blob" | "detection" | "image-info";

interface ExecuteMessage {
  type: "execute";
  taskId: string;
  operation: WorkerOperation;
  resultKind: WorkerResultKind;
  options: unknown;
}

interface OffscreenCanvasWithEncoding extends OffscreenCanvas {
  toDataURL(type?: string, quality?: number): string;
  toBlob(callback: (blob: Blob | null) => void, type?: string, quality?: number): void;
}

interface WorkerImage extends OffscreenCanvas {
  src: string;
  naturalWidth: number;
  naturalHeight: number;
  complete: boolean;
  onload: (() => void) | null;
  onerror: ((event?: unknown) => void) | null;
  decode(): Promise<void>;
}

interface WorkerCanvasResources {
  resources: WebResourceAdapter;
  exportLatestCanvas(format: unknown, quality: unknown): Promise<Blob>;
  dispose(): void;
}

interface WorkerFontResource {
  family: string;
  source: Blob;
}

self.onmessage = (event: MessageEvent<ExecuteMessage>) => {
  const message = event.data;
  if (message.type !== "execute") return;
  void execute(message).then(
    (value) => self.postMessage({ type: "result", taskId: message.taskId, value }),
    (error) => self.postMessage({
      type: "error",
      taskId: message.taskId,
      code: error instanceof Error && error.message.includes("不支持") ? "unsupported" : "execution_failed",
      message: safeWorkerError(error),
    }),
  );
};

async function execute(request: ExecuteMessage): Promise<unknown> {
  const canvasResources = createWorkerCanvasResources();
  const marker = createWebMarker({ resources: canvasResources.resources });
  try {
    const prepared = await prepareWorkerOptions(request.options);
    const value = await runOperation(marker, request.operation, prepared);
    if (request.resultKind === "marker-result") {
      const markerResult = value as MarkerResult;
      const output = readOutputOptions(prepared);
      const blob = await canvasResources.exportLatestCanvas(output.saveFormat, output.quality);
      return { ...markerResult, uri: await blobToDataUrl(blob), output: "data-url" };
    }
    if (request.resultKind === "blob") {
      const output = readOutputOptions(prepared);
      return canvasResources.exportLatestCanvas(output.saveFormat, output.quality);
    }
    return value;
  } finally {
    await marker.dispose();
    canvasResources.dispose();
  }
}

async function prepareWorkerOptions(value: unknown): Promise<unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const options = { ...(value as Record<string, unknown>) };
  const fonts = options.corerobinFonts;
  delete options.corerobinFonts;
  if (fonts !== undefined) await loadLocalFonts(fonts);
  return options;
}

async function loadLocalFonts(value: unknown): Promise<void> {
  if (!Array.isArray(value)) throw new Error("本地字体资源无效。");
  if (typeof FontFace !== "function") throw new Error("当前 WebView 不支持隔离 Worker 本地字体加载。");
  const fontSet = (self as unknown as { fonts?: { add(face: FontFace): unknown } }).fonts;
  if (!fontSet) throw new Error("当前 WebView 不支持隔离 Worker 字体集合。");
  for (const candidate of value) {
    const font = candidate as Partial<WorkerFontResource>;
    if (typeof font.family !== "string" || !(font.source instanceof Blob)) throw new Error("本地字体资源无效。");
    const face = new FontFace(font.family, await font.source.arrayBuffer());
    await face.load();
    fontSet.add(face);
  }
}

async function runOperation(marker: ReturnType<typeof createWebMarker>, operation: WorkerOperation, options: unknown): Promise<unknown> {
  switch (operation) {
    case "getImageInfo": return marker.getImageInfo(options);
    case "markText": return marker.markText(options as Parameters<typeof marker.markText>[0]);
    case "markImage": return marker.markImage(options as Parameters<typeof marker.markImage>[0]);
    case "mark": return marker.mark(options as Parameters<typeof marker.mark>[0]);
    case "embedInvisible": return marker.embedInvisible(options as Parameters<typeof marker.embedInvisible>[0]);
    case "detectInvisible": return marker.detectInvisible(options as Parameters<typeof marker.detectInvisible>[0]);
  }
}

function createWorkerCanvasResources(): WorkerCanvasResources {
  const canvases = new Set<OffscreenCanvasWithEncoding>();
  let latestCanvas: OffscreenCanvasWithEncoding | null = null;
  const resources: WebResourceAdapter = {
    createImage: () => createWorkerImage(),
    createCanvas: (width, height) => {
      const canvas = createEncodableCanvas(width, height);
      canvases.add(canvas);
      latestCanvas = canvas;
      return canvas;
    },
    createObjectURL: (source) => URL.createObjectURL(source),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    readBlobBytes: (source) => source.arrayBuffer(),
  };

  return {
    resources,
    async exportLatestCanvas(format, quality) {
      if (!latestCanvas) throw new Error("隔离渲染没有生成 Canvas 输出。" );
      const mimeType = outputMimeType(format);
      const blob = await latestCanvas.convertToBlob({ type: mimeType, quality: normalizedQuality(quality) });
      if (blob.type !== mimeType) throw new Error(`当前 WebView 不支持 ${mimeType} 编码。`);
      return blob;
    },
    dispose() {
      for (const canvas of canvases) {
        canvas.width = 1;
        canvas.height = 1;
      }
      canvases.clear();
      latestCanvas = null;
    },
  };
}

function createEncodableCanvas(width: number, height: number): OffscreenCanvasWithEncoding {
  const canvas = new OffscreenCanvas(Math.max(Math.round(width), 1), Math.max(Math.round(height), 1)) as OffscreenCanvasWithEncoding;
  try {
    Object.defineProperties(canvas, {
      // The public SDK's MarkerResult path is synchronous. The value is never
      // exposed: after the SDK completes the composition we export this exact
      // OffscreenCanvas with convertToBlob(), then return the real bytes.
      toDataURL: { value: (type = "image/png") => `data:${type};base64,` },
      toBlob: {
        value: (callback: (blob: Blob | null) => void, type = "image/png", quality?: number) => {
          void canvas.convertToBlob({ type, quality }).then(callback, () => callback(null));
        },
      },
    });
  } catch {
    throw new Error("当前 WebView 无法为 OffscreenCanvas 建立受限编码资源。" );
  }
  return canvas;
}

function createWorkerImage(): WorkerImage {
  const canvas = new OffscreenCanvas(1, 1) as WorkerImage;
  let source = "";
  let loadGeneration = 0;
  let loading: Promise<void> = Promise.resolve();
  let naturalWidth = 0;
  let naturalHeight = 0;
  let complete = false;
  let onload: (() => void) | null = null;
  let onerror: ((event?: unknown) => void) | null = null;
  Object.defineProperties(canvas, {
    src: {
      get: () => source,
      set: (next: string) => {
        source = next;
        const generation = ++loadGeneration;
        complete = false;
        naturalWidth = 0;
        naturalHeight = 0;
        if (!next) {
          canvas.width = 1;
          canvas.height = 1;
          return;
        }
        loading = loadWorkerImage(next).then((bitmap) => {
          if (generation !== loadGeneration) {
            bitmap.close();
            return;
          }
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          const context = canvas.getContext("2d");
          if (!context) throw new Error("OffscreenCanvas 2D 不可用。" );
          context.drawImage(bitmap, 0, 0);
          naturalWidth = bitmap.width;
          naturalHeight = bitmap.height;
          bitmap.close();
          complete = true;
          onload?.();
        }).catch((error) => {
          if (generation === loadGeneration) onerror?.(error);
          throw error;
        });
      },
    },
    naturalWidth: { get: () => naturalWidth },
    naturalHeight: { get: () => naturalHeight },
    complete: { get: () => complete },
    onload: { get: () => onload, set: (value: (() => void) | null) => { onload = value; } },
    onerror: { get: () => onerror, set: (value: ((event?: unknown) => void) | null) => { onerror = value; } },
    decode: { value: () => loading },
  });
  return canvas;
}

async function loadWorkerImage(uri: string): Promise<ImageBitmap> {
  const response = await fetch(uri);
  if (!response.ok) throw new Error("无法读取本地图片输入。" );
  return createImageBitmap(await response.blob(), { imageOrientation: "from-image" });
}

function readOutputOptions(value: unknown): { saveFormat: unknown; quality: unknown } {
  if (!value || typeof value !== "object") return { saveFormat: undefined, quality: undefined };
  const record = value as Record<string, unknown>;
  return { saveFormat: record.saveFormat, quality: record.quality };
}

function outputMimeType(format: unknown): "image/png" | "image/jpeg" | "image/webp" {
  if (format === "jpg") return "image/jpeg";
  if (format === "webp") return "image/webp";
  return "image/png";
}

function normalizedQuality(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value / 100)) : undefined;
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return `data:${blob.type};base64,${btoa(binary)}`;
}

function safeWorkerError(error: unknown): string {
  if (!(error instanceof Error)) return "图片隔离执行失败。";
  if (error.message.includes("不支持") || error.message.includes("不可用")) return error.message.slice(0, 180);
  return "图片隔离执行失败。";
}
