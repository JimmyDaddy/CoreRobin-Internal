import { beforeEach, describe, expect, it, vi } from "vitest";
import { strFromU8, unzipSync } from "fflate";

const { startDiffBytes, startPatchBytes, verifyPatch, inspectPatch } = vi.hoisted(() => ({
  startDiffBytes: vi.fn(),
  startPatchBytes: vi.fn(),
  verifyPatch: vi.fn(),
  inspectPatch: vi.fn(),
}));

vi.mock("bs-diff-patch-web", async (importOriginal) => {
  const actual = await importOriginal<typeof import("bs-diff-patch-web")>();
  return { ...actual, startDiffBytes, startPatchBytes, verifyPatch, inspectPatch };
});

import {
  applyPatchAndVerify,
  calculateTransferSavings,
  createPatchCollection,
  inspectPatchSafely,
  makePatchBundle,
  makePatchManifest,
  manifestJson,
  patchInputLimit,
  planPatches,
  planPatchesFromSources,
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
    startPatchBytes.mockReset();
    verifyPatch.mockReset();
    inspectPatch.mockReset();
    inspectPatch.mockResolvedValue({ format: "ENDSLEY/BSDIFF43", patchBytes: 24, headerBytes: 24, payloadBytes: 0, declaredTargetBytes: "2000000", valid: true });
    startPatchBytes.mockImplementation(() => ({ result: Promise.resolve(new Uint8Array(2_000_000)) }));
  });

  it("hashes bytes and keeps signing payload as data rather than a signature", async () => {
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("recognizes malformed patch data without treating it as trusted", async () => {
    inspectPatch.mockResolvedValue({ format: "UNKNOWN", patchBytes: 7, headerBytes: 7, payloadBytes: 0, declaredTargetBytes: null, valid: false, issue: "TRUNCATED_HEADER" });
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

  it("packages the formal plan, full fallback, and only verified patch artifacts", async () => {
    const collection = await createPatchCollection({ name: "../target.bin", data: new Uint8Array([7, 8, 9]) }, {
      results: [
        { baselineName: "../old.bin", baselineBytes: 3, baselineSha256: "a".repeat(64), status: "verified", patch: new Uint8Array([1, 2]), ratio: 2 / 3, error: null },
        { baselineName: "rejected.bin", baselineBytes: 3, baselineSha256: "b".repeat(64), status: "failed", patch: null, ratio: 1, error: null },
      ],
      excluded: [],
      artifactBytes: 2,
      artifactLimitBytes: 512,
      workingSetBytes: 8,
      workingSetLimitBytes: 512,
    });

    const archive = unzipSync(collection.bytes);
    expect(collection.filename).toBe("corerobin-patch-collection.zip");
    expect(Object.keys(archive).sort()).toEqual(["full/target.bin", "patch-plan.json", "patches/01-old.bin.endsley.patch"]);
    expect([...archive["full/target.bin"]]).toEqual([7, 8, 9]);
    expect([...archive["patches/01-old.bin.endsley.patch"]]).toEqual([1, 2]);
    expect(JSON.parse(strFromU8(archive["patch-plan.json"]))).toMatchObject({
      target: { name: "target.bin", url: "full/target.bin" },
      full: { name: "target.bin", url: "full/target.bin" },
      patches: [{ baseline: { name: "old.bin" }, patch: { name: "01-old.bin.endsley.patch", url: "patches/01-old.bin.endsley.patch" } }],
    });
  });

  it("rejects a final collection that exceeds its total byte budget", async () => {
    await expect(createPatchCollection({ name: "target.bin", data: new Uint8Array([7, 8, 9]) }, {
      results: [],
      excluded: [],
      artifactBytes: 0,
      artifactLimitBytes: 512,
      workingSetBytes: 3,
      workingSetLimitBytes: 512,
    }, 2)).rejects.toMatchObject({ code: "ERESOURCE" });
  });

  it("keeps role limits explicit and strips path components from manifest names", async () => {
    expect(patchInputLimit("baseline")).toBe(16 * 1024 * 1024);
    expect(patchInputLimit("patch")).toBe(64 * 1024 * 1024);
    await expect(makePatchManifest(new Uint8Array(1), new Uint8Array(2), new Uint8Array(3), { baseline: "../../secret.bin" })).resolves.toMatchObject({ baseline: { name: "secret.bin" } });
  });

  it("never applies BSDIFF40 data", async () => {
    inspectPatch.mockResolvedValue({ format: "BSDIFF40", patchBytes: 24, headerBytes: 24, payloadBytes: 0, declaredTargetBytes: null, valid: false, issue: "LEGACY_FORMAT" });
    await expect(applyPatchAndVerify(new Uint8Array([0]), new Uint8Array(24), new Uint8Array([1]))).rejects.toMatchObject({ code: "EPATCH" });
    expect(startPatchBytes).not.toHaveBeenCalled();
  });

  it("requires an independent byte-for-byte replay after SDK verification", async () => {
    verifyPatch.mockResolvedValue(verifiedPatch);
    startPatchBytes.mockImplementation(() => ({ result: Promise.resolve(new Uint8Array([2])) }));
    await expect(applyPatchAndVerify(new Uint8Array([0]), new Uint8Array(24), new Uint8Array([1]))).rejects.toMatchObject({ code: "EVERIFICATION" });
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

  it("loads lazy baselines one at a time and keeps planning serial", async () => {
    const order: string[] = [];
    startDiffBytes.mockImplementation(() => ({ result: Promise.resolve(new Uint8Array([9])) }));
    startPatchBytes.mockImplementation(() => ({ result: Promise.resolve(new Uint8Array([9])) }));
    verifyPatch.mockResolvedValue(verifiedPatch);
    const plan = await planPatchesFromSources(new Uint8Array([9]), [
      { name: "first", load: async () => { order.push("load:first"); return new Uint8Array([1]); } },
      { name: "second", load: async () => { order.push("load:second"); return new Uint8Array([2]); } },
    ], 2);
    expect(order).toEqual(["load:first", "load:second"]);
    expect(plan.results.map((item) => item.baselineName)).toEqual(["first", "second"]);
    expect(plan.workingSetBytes).toBe(3);
  });

  it("reports an oversized lazy baseline as a failed item", async () => {
    const plan = await planPatchesFromSources(new Uint8Array([1]), [{ name: "too-large", load: async () => new Uint8Array(patchInputLimit("baseline") + 1) }]);
    expect(plan.results[0]).toMatchObject({ baselineName: "too-large", status: "failed", error: { code: "ERESOURCE" } });
  });

  it("rejects unsafe transfer-savings inputs and arithmetic", () => {
    expect(calculateTransferSavings(1_000, 100, 2)).toEqual({ fullBytes: 2_000, patchBytes: 200, savedBytes: 1_800, savingsPercent: 90 });
    expect(() => calculateTransferSavings(1.5, 1, 1)).toThrow("安全整数");
    expect(() => calculateTransferSavings(Number.POSITIVE_INFINITY, 1, 1)).toThrow("安全整数");
    expect(() => calculateTransferSavings(Number.MAX_SAFE_INTEGER, 1, 2)).toThrow("累计传输大小");
  });
});
