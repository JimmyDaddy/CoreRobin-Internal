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
export const BATCH_MAX_INPUT_BYTES = 80 * 1024 * 1024;
export const IMAGE_MAX_WORKSET_BYTES = 256 * 1024 * 1024;
export const IMAGE_MAX_EXPORT_BYTES = 512 * 1024 * 1024;

export interface ImageBudget {
  file: File;
  info: MarkerImageInfo;
  pixels: number;
}

export interface LocalManifestInspection {
  format: "json" | "unknown";
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
  return { file, info, pixels };
}

export function assertBatchBudget(files: readonly File[]): void {
  if (files.length > BATCH_MAX_FILES) throw new Error("批量处理最多选择 20 张图片。");
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > BATCH_MAX_INPUT_BYTES) throw new Error("批量输入总大小不能超过 80 MiB。");
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
  if (new TextEncoder().encode(source).byteLength > 256 * 1024) throw new Error("Manifest 材料不能超过 256 KiB。");
  let value: unknown;
  try { value = JSON.parse(source); } catch { return { format: "unknown", manifests: 0, claimGenerator: null, trust: "unknown", networkAccessed: false, note: "材料不是 JSON；未判断为 C2PA。" }; }
  if (!value || typeof value !== "object") return { format: "unknown", manifests: 0, claimGenerator: null, trust: "unknown", networkAccessed: false, note: "材料不是对象；信任状态 unknown。" };
  const root = value as Record<string, unknown>;
  const manifests = root.manifests && typeof root.manifests === "object" ? Object.keys(root.manifests as object).length : 0;
  const claimGenerator = typeof root.claim_generator === "string" ? root.claim_generator : null;
  return { format: manifests > 0 || "c2pa" in root ? "json" : "unknown", manifests, claimGenerator, trust: "unknown", networkAccessed: false, note: "仅解析本地材料；未联网、未验证签名或信任链。" };
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
