import type { MarkerResult } from "@image-marker/web";

import { dataUrlToBytes } from "./imageTools";

export interface ImageOutputPayload {
  kind: "image" | "recipe" | "archive";
  filename: string;
  blob: Blob;
}

/**
 * W02's TTL-bound output provider plugs in here. Until it exists, callers may
 * create a browser-only preview URL, but that path is never a formal export.
 */
export type ImageOutputDelivery = (payload: ImageOutputPayload) => Promise<void>;

export function markerResultOutput(result: MarkerResult, fallbackName = "corerobin-image"): ImageOutputPayload {
  const bytes = dataUrlToBytes(result.uri);
  const output = new Uint8Array(bytes.byteLength);
  output.set(bytes);
  return {
    kind: "image",
    filename: result.filename ?? `${fallbackName}.${result.format}`,
    blob: new Blob([output.buffer], { type: imageMimeType(result.format) }),
  };
}

export function recipeOutput(source: string, filename = "corerobin-recipe.json"): ImageOutputPayload {
  return { kind: "recipe", filename, blob: new Blob([source], { type: "application/json" }) };
}

export function archiveOutput(bytes: ArrayBuffer, filename = "corerobin-watermarks.zip"): ImageOutputPayload {
  return { kind: "archive", filename, blob: new Blob([bytes], { type: "application/zip" }) };
}

export function previewObjectUrl(payload: ImageOutputPayload): string {
  return URL.createObjectURL(payload.blob);
}

function imageMimeType(format: MarkerResult["format"]): "image/png" | "image/jpeg" | "image/webp" {
  if (format === "jpeg") return "image/jpeg";
  return format === "webp" ? "image/webp" : "image/png";
}
