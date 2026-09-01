import {
  createWatermarkRecipeDefinition,
  safeValidateWatermarkRecipe,
  type MarkerImageInfo,
  type MarkerResult,
  type WatermarkRecipeDefinition,
  type WebMarkerInstance,
} from "@image-marker/web";

import i18n from "../../i18n";

export const IMAGE_MAX_BYTES = 12 * 1024 * 1024;
export const IMAGE_MAX_PIXELS = 16_000_000;
export const IMAGE_MAX_OUTPUT_EDGE = 2048;
export const BATCH_MAX_FILES = 20;
export const RECIPIENT_MAX_FILES = 30;
export const BATCH_MAX_INPUT_BYTES = 80 * 1024 * 1024;
export const IMAGE_MAX_WORKSET_BYTES = 256 * 1024 * 1024;
export const IMAGE_MAX_EXPORT_BYTES = 512 * 1024 * 1024;

export type LocalFontMimeType = "font/ttf" | "font/otf" | "font/woff" | "font/woff2";

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

export async function inspectImageBudget(marker: WebMarkerInstance, file: File): Promise<ImageBudget> {
  if (file.size > IMAGE_MAX_BYTES) {
    throw imageError("imageTooLarge", { maxMiB: Math.round(IMAGE_MAX_BYTES / 1024 / 1024) });
  }
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    throw imageError("unsupportedImageFormat");
  }
  const info = await marker.getImageInfo(file);
  const pixels = info.width * info.height;
  if (!Number.isSafeInteger(pixels) || pixels > IMAGE_MAX_PIXELS) {
    throw imageError("imagePixelLimit", { maxPixels: IMAGE_MAX_PIXELS / 1_000_000 });
  }
  const estimatedWorksetBytes = estimateImageWorksetBytes(file.size, pixels);
  if (estimatedWorksetBytes > IMAGE_MAX_WORKSET_BYTES) {
    throw imageError("imageWorksetLimit", { maxMiB: IMAGE_MAX_WORKSET_BYTES / 1024 / 1024 });
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
    throw imageError("imageBudgetInvalid");
  }
  const sourceRgbaBytes = sourcePixels * 4;
  const outputPixels = Math.min(sourcePixels, IMAGE_MAX_OUTPUT_EDGE * IMAGE_MAX_OUTPUT_EDGE);
  const outputRgbaBytes = outputPixels * 4;
  const estimate = sourceRgbaBytes * 3 + outputRgbaBytes * 3 + inputBytes;
  if (!Number.isSafeInteger(estimate)) throw imageError("imageWorksetOverflow");
  return estimate;
}

export function assertBatchBudget(files: readonly File[]): void {
  createBatchZipBudget(files);
}

/** Validate the container signature before handing a selected font to a Worker. */
export function inspectLocalFontBytes(name: string, bytes: Uint8Array): LocalFontMimeType {
  if (bytes.byteLength === 0) throw imageError("localFontEmpty");
  const extension = name.trim().toLowerCase().match(/\.([a-z0-9]+)$/u)?.[1];
  const mimeType = extension === "ttf" ? "font/ttf"
    : extension === "otf" ? "font/otf"
      : extension === "woff" ? "font/woff"
        : extension === "woff2" ? "font/woff2"
          : null;
  if (!mimeType) throw imageError("localFontUnsupported");
  const signature = String.fromCharCode(...bytes.subarray(0, 4));
  const isSfnt = (bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0)
    || signature === "OTTO"
    || signature === "true"
    || signature === "typ1";
  const kindMatches = mimeType === "font/woff" ? signature === "wOFF"
    : mimeType === "font/woff2" ? signature === "wOF2"
      : isSfnt;
  if (!kindMatches) throw imageError("localFontSignatureMismatch");
  return mimeType;
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
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) throw imageError("inputByteLengthInvalid");
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
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) throw imageError("outputByteLengthInvalid");
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
  if (budget.inputBytes > BATCH_MAX_INPUT_BYTES) throw imageError("zipInputBudgetExceeded", { maxMiB: BATCH_MAX_INPUT_BYTES / 1024 / 1024 });
  return budget;
}

export function assertBatchZipBudget(budget: BatchZipBudget): void {
  if (budget.inputFileCount > BATCH_MAX_FILES || budget.outputFileCount > budget.maxOutputFiles) {
    throw imageError("zipFileLimitExceeded", { maxInputFiles: BATCH_MAX_FILES, maxOutputFiles: budget.maxOutputFiles });
  }
  if (budget.inputBytes > BATCH_MAX_INPUT_BYTES) throw imageError("zipInputBudgetExceeded", { maxMiB: BATCH_MAX_INPUT_BYTES / 1024 / 1024 });
  if (budget.outputBytes > IMAGE_MAX_EXPORT_BYTES) throw imageError("zipOutputBudgetExceeded", { maxMiB: IMAGE_MAX_EXPORT_BYTES / 1024 / 1024 });
}

export function createImageAbortError(message = imageError("processingCancelled").message): Error {
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
    throw imageError("recipientLocatorListInvalid", { maxFiles: RECIPIENT_MAX_FILES });
  }
  const seen = new Set<string>();
  for (const value of values) {
    if (new TextEncoder().encode(value).byteLength > 12) throw imageError("recipientLocatorTooLong", { maxBytes: 12 });
    if (seen.has(value)) throw imageError("recipientLocatorDuplicate");
    seen.add(value);
  }
  return values;
}

/** Accept a key only from the current interaction; callers must not persist it. */
export function requireOneTimeRecipientKey(value: string | null): string {
  const key = value?.trim() ?? "";
  if (!key) throw imageError("recipientKeyRequired");
  if (new TextEncoder().encode(key).byteLength < 16) throw imageError("recipientKeyTooShort", { minBytes: 16 });
  return key;
}

export function createTextRecipe(text: string, color: string, alpha: number): WatermarkRecipeDefinition {
  const trimmed = text.trim();
  if (!trimmed) throw imageError("recipeTextRequired");
  if (new TextEncoder().encode(trimmed).byteLength > 4096) throw imageError("recipeTextTooLong", { maxKiB: 4 });
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
  if (new TextEncoder().encode(source).byteLength > 64 * 1024) throw imageError("recipeTooLarge", { maxKiB: 64 });
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw imageError("recipeJsonInvalid"); }
  const validated = safeValidateWatermarkRecipe(value);
  if (!validated.success) throw imageError("recipeValidationFailed");
  return validated.value;
}

export function dataUrlToBytes(uri: string): Uint8Array {
  const comma = uri.indexOf(",");
  if (comma < 0 || !uri.startsWith("data:")) throw imageError("localDataUrlRequired");
  const encoded = uri.slice(comma + 1);
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function resultLabel(result: MarkerResult): string {
  return `${result.format.toUpperCase()} · ${result.durationMs} ms · ${result.metadata.policy} metadata`;
}

function imageError(key: string, options?: Record<string, unknown>): Error {
  return new Error(i18n.t(`toolbox:image.errors.${key}` as never, options));
}
