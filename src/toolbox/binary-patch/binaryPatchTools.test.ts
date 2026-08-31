import { beforeEach, describe, expect, it, vi } from "vitest";

const { startDiffBytes, verifyPatch } = vi.hoisted(() => ({
  startDiffBytes: vi.fn(),
  verifyPatch: vi.fn(),
}));

vi.mock("bs-diff-patch-web", async (importOriginal) => {
  const actual = await importOriginal<typeof import("bs-diff-patch-web")>();
  return { ...actual, startDiffBytes, verifyPatch };
});

import {
  calculateTransferSavings,
  inspectPatchSafely,
  makePatchBundle,
  manifestJson,
  planPatches,
  runWithPatchDeadline,
  sha256Hex,
} from "./binaryPatchTools";

const verifiedPatch = {
  verified: true,
  restoredBytes: 1,
  expectedBytes: 1,
  patch: { format: "ENDSLEY/BSDIFF43", patchBytes: 1, headerBytes: 24, payloadBytes: 0, declaredTargetBytes: "1", valid: true },
};

describe("binary patch toolbox boundaries", () => {
  beforeEach(() => {
    startDiffBytes.mockReset();
    verifyPatch.mockReset();
  });

  it("hashes bytes and keeps signing payload as data rather than a signature", async () => {
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("recognizes malformed patch data without treating it as trusted", async () => {
    const inspection = await inspectPatchSafely(new Uint8Array([69, 78, 68, 83, 76, 69, 89]));
    expect(inspection.valid).toBe(false);
    expect(inspection.issue).toBe("TRUNCATED_HEADER");
  });

  it("creates a data-only bundle with no network behavior", () => {
    const target = { bytes: 3, sha256: "c".repeat(64) };
    const bundle = makePatchBundle(target, target);
    expect(bundle.patches).toHaveLength(0);
    expect(manifestJson({ version: 1, format: "ENDSLEY/BSDIFF43", baseline: { bytes: 1, sha256: "a".repeat(64) }, patch: { bytes: 2, sha256: "b".repeat(64) }, target: { bytes: 3, sha256: "c".repeat(64) } })).not.toContain("signature");
  });

  it("terminates cancellation instead of allowing a planner to continue", async () => {
    startDiffBytes.mockImplementation((_oldData, _newData, options: { signal: AbortSignal }) => ({
      result: new Promise<Uint8Array>((_resolve, reject) => options.signal.addEventListener("abort", () => reject(Object.assign(new Error("worker stopped"), { code: "EABORTED" })), { once: true })),
    }));
    const controller = new AbortController();
    const planned = planPatches(new Uint8Array([1]), [{ name: "baseline", data: new Uint8Array([0]) }], 0.8, controller.signal);
    controller.abort();

    await expect(planned).rejects.toMatchObject({ name: "AbortError", code: "EABORTED" });
    await expect(runWithPatchDeadline(async (signal) => new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true })), controller.signal)).rejects.toMatchObject({ name: "AbortError", code: "EABORTED" });
  });

  it("excludes patches that would exceed the cumulative artifact budget", async () => {
    startDiffBytes.mockImplementation(() => ({ result: Promise.resolve(new Uint8Array(1_000_000)) }));
    verifyPatch.mockResolvedValue(verifiedPatch);

    const plan = await planPatches(new Uint8Array(2_000_000), [
      { name: "first", data: new Uint8Array([1]) },
      { name: "second", data: new Uint8Array([2]) },
    ], 0.8, undefined, 1_500_000);

    expect(plan.results.map((item) => item.baselineName)).toEqual(["first"]);
    expect(plan.artifactBytes).toBe(1_000_000);
    expect(plan.excluded).toEqual([{ baselineName: "second", patchBytes: 1_000_000, reason: "artifact_budget" }]);
  });

  it("rejects unsafe transfer-savings inputs and arithmetic", () => {
    expect(calculateTransferSavings(1_000, 100, 2)).toEqual({ fullBytes: 2_000, patchBytes: 200, savedBytes: 1_800, savingsPercent: 90 });
    expect(() => calculateTransferSavings(1.5, 1, 1)).toThrow("安全整数");
    expect(() => calculateTransferSavings(Number.POSITIVE_INFINITY, 1, 1)).toThrow("安全整数");
    expect(() => calculateTransferSavings(Number.MAX_SAFE_INTEGER, 1, 2)).toThrow("累计传输大小");
  });
});
