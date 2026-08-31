import { describe, expect, it } from "vitest";
import {
  BATCH_MAX_FILES,
  BATCH_MAX_INPUT_BYTES,
  IMAGE_MAX_EXPORT_BYTES,
  appendBatchInput,
  appendBatchZipOutput,
  createBatchZipBudget,
  createImageAbortError,
  createRecipientZipBudget,
  createTextRecipe,
  estimateImageWorksetBytes,
  inspectLocalManifest,
  isAbortError,
  parseRecipeDocument,
  parseRecipientLocators,
  requireOneTimeRecipientKey,
} from "./imageTools";

describe("image toolbox contracts", () => {
  it("creates and validates a portable Recipe document", () => {
    const recipe = createTextRecipe("CoreRobin", "#ffffff", 0.8);
    const parsed = parseRecipeDocument(JSON.stringify(recipe));
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.layers).toHaveLength(1);
  });

  it("does not treat a local manifest as trusted", () => {
    const result = inspectLocalManifest(JSON.stringify({ manifests: { abc: {} }, claim_generator: "local" }));
    expect(result.status).toBe("parsed_unverified");
    expect(result.manifests).toBe(1);
    expect(result.trust).toBe("unknown");
    expect(result.networkAccessed).toBe(false);
  });

  it("distinguishes malformed and non-C2PA JSON without network lookup", () => {
    expect(inspectLocalManifest("not-json").status).toBe("malformed");
    expect(inspectLocalManifest(JSON.stringify({ value: true })).status).toBe("not_c2pa");
  });

  it("enforces ZIP input limits before processing and cumulative output limits while processing", () => {
    const file = { size: BATCH_MAX_INPUT_BYTES } as File;
    const budget = createBatchZipBudget([file]);

    expect(budget).toMatchObject({ inputFileCount: 1, inputBytes: BATCH_MAX_INPUT_BYTES, outputBytes: 0 });
    expect(() => createBatchZipBudget([{ size: BATCH_MAX_INPUT_BYTES + 1 } as File])).toThrow("80 MiB");
    expect(() => appendBatchZipOutput(budget, IMAGE_MAX_EXPORT_BYTES + 1)).toThrow("512 MiB");
    expect(() => appendBatchZipOutput({ ...budget, outputFileCount: BATCH_MAX_FILES }, 1)).toThrow("20");
    expect(() => appendBatchInput({ ...createBatchZipBudget([]), inputFileCount: BATCH_MAX_FILES }, 1)).toThrow("20");
    expect(() => appendBatchZipOutput({ ...createRecipientZipBudget({ size: 0 } as File), outputFileCount: 30 }, 1)).toThrow("30");
    expect(() => createBatchZipBudget(Array.from({ length: BATCH_MAX_FILES + 1 }, () => ({ size: 0 } as File)))).toThrow("20");
  });

  it("requires a one-time recipient key and keeps cancellation identifiable as AbortError", () => {
    expect(() => requireOneTimeRecipientKey(null)).toThrow("一次性分发密钥");
    expect(requireOneTimeRecipientKey("operator supplied key")).toBe("operator supplied key");
    expect(parseRecipientLocators("r-a,r-b")).toEqual(["r-a", "r-b"]);
    expect(() => parseRecipientLocators("duplicate,duplicate")).toThrow("不能重复");
    expect(isAbortError(createImageAbortError())).toBe(true);
  });

  it("keeps a single decoded image within the 256 MiB execution admission budget", () => {
    expect(estimateImageWorksetBytes(12 * 1024 * 1024, 16_000_000)).toBeLessThanOrEqual(256 * 1024 * 1024);
    expect(estimateImageWorksetBytes(12 * 1024 * 1024, 20_000_000)).toBeGreaterThan(256 * 1024 * 1024);
    expect(parseRecipientLocators(Array.from({ length: 30 }, (_, index) => `r-${index}`).join(","))).toHaveLength(30);
  });
});
