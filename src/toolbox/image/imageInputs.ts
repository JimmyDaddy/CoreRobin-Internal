import type { WebMarkerInstance } from "@image-marker/web";

import i18n from "../../i18n";
import type { ToolboxFileJobKey, ToolboxInputToken } from "../contracts";
import { readBoundToolboxInput } from "../runtime/files";
import { inspectImageBudget } from "./imageTools";

export const IMAGE_INPUT_MAX_BYTES = 12 * 1024 * 1024;

export interface ImageRunInputs {
  count: number;
  read(index: number): Promise<File>;
}

export function createBrowserImageInputs(marker: WebMarkerInstance, files: readonly File[], signal: AbortSignal): ImageRunInputs {
  return {
    count: files.length,
    async read(index) {
      signal.throwIfAborted();
      const file = files[index];
      if (!file) throw new Error(i18n.t("toolbox:image.inputUnavailable"));
      return (await inspectImageBudget(marker, file)).file;
    },
  };
}

/**
 * Native input transport never exposes a file path. The W02 reader performs
 * serial <= 1 MiB reads and verifies job/generation/resetEpoch on every call;
 * this adapter only materializes one current-operation File for the Worker.
 */
export function createNativeImageInputs(marker: WebMarkerInstance, job: ToolboxFileJobKey, tokens: readonly ToolboxInputToken[], signal: AbortSignal): ImageRunInputs {
  return {
    count: tokens.length,
    async read(index) {
      const token = tokens[index];
      if (!token) throw new Error(i18n.t("toolbox:image.inputUnavailable"));
      const bytes = await readBoundToolboxInput(job, token, signal, IMAGE_INPUT_MAX_BYTES);
      signal.throwIfAborted();
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const file = new File([buffer], token.displayName, { type: imageMimeType(bytes, token.displayName) });
      return (await inspectImageBudget(marker, file)).file;
    },
  };
}

export function imageMimeType(bytes: Uint8Array, name: string): "image/png" | "image/jpeg" | "image/webp" | "application/octet-stream" {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") return "image/webp";
  if (/\.png$/iu.test(name)) return "image/png";
  if (/\.jpe?g$/iu.test(name)) return "image/jpeg";
  if (/\.webp$/iu.test(name)) return "image/webp";
  return "application/octet-stream";
}

/** C2PA must not accept a renamed or extension-only input as an image. */
export function strictImageMimeType(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | "application/octet-stream" {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") return "image/webp";
  return "application/octet-stream";
}
