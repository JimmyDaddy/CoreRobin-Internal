import {
  createWatermarkRecipeDefinition,
  safeValidateWatermarkRecipe,
  type MarkerImageInfo,
  type MarkerResult,
  type WatermarkRecipeDefinition,
  type WebMarkerInstance,
} from "@image-marker/web";

export const IMAGE_MAX_BYTES = 12 * 1024 * 1024;
export const IMAGE_MAX_PIXELS = 16_000_000;
export const IMAGE_MAX_OUTPUT_EDGE = 2048;
export const BATCH_MAX_FILES = 20;
export const RECIPIENT_MAX_FILES = 30;
export const BATCH_MAX_INPUT_BYTES = 80 * 1024 * 1024;
export const IMAGE_MAX_WORKSET_BYTES = 256 * 1024 * 1024;
export const IMAGE_MAX_EXPORT_BYTES = 512 * 1024 * 1024;
export const LOCAL_MANIFEST_MAX_BYTES = 4 * 1024 * 1024;

export interface BatchZipBudget {
  inputFileCount: number;
  inputBytes: number;
  outputFileCount: number;
  outputBytes: number;
  maxOutputFiles: number;
}

export interface ImageBudget {
  file: File;
  info: MarkerImageInfo;
  pixels: number;
  estimatedWorksetBytes: number;
}

export interface LocalManifestInspection {
  format: "json" | "unknown";
  status: "parsed_unverified" | "not_c2pa" | "malformed";
  manifests: number;
  claimGenerator: string | null;
  trust: "unknown";
  networkAccessed: false;
  note: string;
}

export async function inspectImageBudget(marker: WebMarkerInstance, file: File): Promise<ImageBudget> {
  if (file.size > IMAGE_MAX_BYTES) {
    throw new Error(`图片不能超过 ${Math.round(IMAGE_MAX_BYTES / 1024 / 1024)} MiB。`);
  }
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    throw new Error("只支持 PNG、JPEG 和 WebP 图片。");
  }
  const info = await marker.getImageInfo(file);
  const pixels = info.width * info.height;
  if (!Number.isSafeInteger(pixels) || pixels > IMAGE_MAX_PIXELS) {
    throw new Error("图片解码像素不能超过 1600 万。");
  }
  const estimatedWorksetBytes = estimateImageWorksetBytes(file.size, pixels);
  if (estimatedWorksetBytes > IMAGE_MAX_WORKSET_BYTES) {
    throw new Error("图片在解码、渲染和编码阶段会超过 256 MiB 工作集预算。");
  }
  return { file, info, pixels, estimatedWorksetBytes };
}

/**
 * One isolated image task owns a decoded source, canvas/pixel working copies,
 * bounded 2048px output and its encoded input. This is deliberately a
 * conservative admission estimate, not a claim that the browser enforces a
 * process-wide memory limit.
 */
export function estimateImageWorksetBytes(inputBytes: number, sourcePixels: number): number {
  if (!Number.isSafeInteger(inputBytes) || inputBytes < 0 || !Number.isSafeInteger(sourcePixels) || sourcePixels < 1) {
    throw new Error("图片预算参数无效。");
  }
  const sourceRgbaBytes = sourcePixels * 4;
  const outputPixels = Math.min(sourcePixels, IMAGE_MAX_OUTPUT_EDGE * IMAGE_MAX_OUTPUT_EDGE);
  const outputRgbaBytes = outputPixels * 4;
  const estimate = sourceRgbaBytes * 3 + outputRgbaBytes * 3 + inputBytes;
  if (!Number.isSafeInteger(estimate)) throw new Error("图片工作集预算溢出。");
  return estimate;
}

export function assertBatchBudget(files: readonly File[]): void {
  createBatchZipBudget(files);
}

/** Validate the input half of a ZIP job before any image work starts. */
export function createBatchZipBudget(files: readonly File[]): BatchZipBudget {
  const budget = {
    inputFileCount: files.length,
    inputBytes: files.reduce((sum, file) => sum + file.size, 0),
    outputFileCount: 0,
    outputBytes: 0,
    maxOutputFiles: BATCH_MAX_FILES,
  };
  assertBatchZipBudget(budget);
  return budget;
}

/** Add one native-bound input immediately before it is decoded. */
export function appendBatchInput(budget: BatchZipBudget, byteLength: number): BatchZipBudget {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) throw new Error("图片输入大小无效。");
  const next = {
    ...budget,
    inputFileCount: budget.inputFileCount + 1,
    inputBytes: budget.inputBytes + byteLength,
  };
  assertBatchZipBudget(next);
  return next;
}

/**
 * Add one encoded output while enforcing all ZIP limits again. This prevents a
 * lossy source image from expanding beyond the export cap after preflight.
 */
export function appendBatchZipOutput(budget: BatchZipBudget, byteLength: number): BatchZipBudget {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) throw new Error("图片输出大小无效。");
  const next = {
    ...budget,
    outputFileCount: budget.outputFileCount + 1,
    outputBytes: budget.outputBytes + byteLength,
  };
  assertBatchZipBudget(next);
  return next;
}

export function createRecipientZipBudget(file: File): BatchZipBudget {
  const budget = {
    inputFileCount: 1,
    inputBytes: file.size,
    outputFileCount: 0,
    outputBytes: 0,
    maxOutputFiles: RECIPIENT_MAX_FILES,
  };
  if (budget.inputBytes > BATCH_MAX_INPUT_BYTES) throw new Error("批量输入总大小不能超过 80 MiB。");
  return budget;
}

export function assertBatchZipBudget(budget: BatchZipBudget): void {
  if (budget.inputFileCount > BATCH_MAX_FILES || budget.outputFileCount > budget.maxOutputFiles) {
    throw new Error(`批量 ZIP 最多包含 20 个输入和 ${budget.maxOutputFiles} 个输出文件。`);
  }
  if (budget.inputBytes > BATCH_MAX_INPUT_BYTES) throw new Error("批量输入总大小不能超过 80 MiB。");
  if (budget.outputBytes > IMAGE_MAX_EXPORT_BYTES) throw new Error("批量 ZIP 累计输出不能超过 512 MiB。");
}

export function createImageAbortError(message = "图片处理已停止。"): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export function isAbortError(reason: unknown): reason is Error {
  return reason instanceof Error && reason.name === "AbortError";
}

export function parseRecipientLocators(source: string): string[] {
  const values = source.split(",").map((value) => value.trim()).filter(Boolean);
  if (values.length === 0 || values.length > RECIPIENT_MAX_FILES) {
    throw new Error("收件人最多 30 个，且必须使用短 locator；不要直接写入个人资料。");
  }
  const seen = new Set<string>();
  for (const value of values) {
    if (new TextEncoder().encode(value).byteLength > 12) throw new Error("每个收件人 locator 不能超过 12 UTF-8 字节。");
    if (seen.has(value)) throw new Error("收件人 locator 不能重复。");
    seen.add(value);
  }
  return values;
}

/** Accept a key only from the current interaction; callers must not persist it. */
export function requireOneTimeRecipientKey(value: string | null): string {
  const key = value?.trim() ?? "";
  if (!key) throw new Error("需要一次性分发密钥；它只保留在当前操作内存中。");
  if (new TextEncoder().encode(key).byteLength < 16) throw new Error("一次性分发密钥至少需要 16 UTF-8 字节。");
  return key;
}

export function createTextRecipe(text: string, color: string, alpha: number): WatermarkRecipeDefinition {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Recipe 文字不能为空。");
  if (new TextEncoder().encode(trimmed).byteLength > 4096) throw new Error("Recipe 文字不能超过 4 KiB。");
  return createWatermarkRecipeDefinition({
    schemaVersion: 2,
    layers: [{
      id: "text-layer",
      name: "文字水印",
      type: "text",
      text: trimmed,
      alpha,
      position: { position: "bottomRight", edgeInset: 24 },
      style: { color, fontSize: 28, bold: false, shadowStyle: { dx: 1, dy: 1, radius: 2, color: "#00000088" } },
    }],
    output: { saveFormat: "png", maxSize: IMAGE_MAX_OUTPUT_EDGE, quality: 92 },
  });
}

export function parseRecipeDocument(source: string): WatermarkRecipeDefinition {
  if (new TextEncoder().encode(source).byteLength > 64 * 1024) throw new Error("Recipe JSON 不能超过 64 KiB。");
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new Error("Recipe JSON 格式无效。"); }
  const validated = safeValidateWatermarkRecipe(value);
  if (!validated.success) throw new Error(`Recipe 校验失败：${validated.error.message}`);
  return validated.value;
}

export function inspectLocalManifest(source: string): LocalManifestInspection {
  if (new TextEncoder().encode(source).byteLength > LOCAL_MANIFEST_MAX_BYTES) throw new Error("Manifest 材料不能超过 4 MiB。");
  let value: unknown;
  try { value = JSON.parse(source); } catch { return { format: "unknown", status: "malformed", manifests: 0, claimGenerator: null, trust: "unknown", networkAccessed: false, note: "材料不是有效 JSON；未判断为 C2PA。" }; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { format: "unknown", status: "malformed", manifests: 0, claimGenerator: null, trust: "unknown", networkAccessed: false, note: "材料不是 C2PA manifest 对象；信任状态 unknown。" };
  const root = value as Record<string, unknown>;
  const manifests = root.manifests && typeof root.manifests === "object" ? Object.keys(root.manifests as object).length : 0;
  const claimGenerator = typeof root.claim_generator === "string" ? root.claim_generator : null;
  if (!root.manifests || typeof root.manifests !== "object" || Array.isArray(root.manifests)) return { format: "unknown", status: "not_c2pa", manifests: 0, claimGenerator, trust: "unknown", networkAccessed: false, note: "JSON 中没有 C2PA manifests 对象；未联网、未验证签名或信任链。" };
  return { format: "json", status: "parsed_unverified", manifests, claimGenerator, trust: "unknown", networkAccessed: false, note: "仅解析本地 manifest 摘要；未联网、未验证签名或信任链。" };
}

export function dataUrlToBytes(uri: string): Uint8Array {
  const comma = uri.indexOf(",");
  if (comma < 0 || !uri.startsWith("data:")) throw new Error("图片结果不是本地 data URL。");
  const encoded = uri.slice(comma + 1);
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function resultLabel(result: MarkerResult): string {
  return `${result.format.toUpperCase()} · ${result.durationMs} ms · ${result.metadata.policy} metadata`;
}
