import {
  classifyPatchError,
  inspectPatch,
  startDiffBytes,
  startPatchBytes,
  verifyPatch,
  type ClassifiedPatchError,
  type PatchMetadata,
  type PatchVerificationResult,
} from "bs-diff-patch-web";
import {
  canonicalJson,
  createPatchBundle,
  createPatchManifest,
  type PatchArtifact,
  type PatchBundle,
  type PatchManifest,
} from "bs-diff-patch-web/toolkit";

const MAX_GENERATE_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_PATCH_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_PATCH_OUTPUT_BYTES = 64 * 1024 * 1024;

export interface VerifiedPatch {
  patch: Uint8Array;
  verification: PatchVerificationResult;
  baselineSha256: string;
  targetSha256: string;
}

export interface PatchPlanItem {
  baselineName: string;
  status: "verified" | "failed";
  patch: Uint8Array | null;
  ratio: number | null;
  error: ClassifiedPatchError | null;
}

export async function generateVerifiedPatch(oldData: Uint8Array, newData: Uint8Array, signal?: AbortSignal): Promise<VerifiedPatch> {
  assertSize(oldData, MAX_GENERATE_INPUT_BYTES, "baseline");
  assertSize(newData, MAX_GENERATE_INPUT_BYTES, "target");
  const diffJob = startDiffBytes(oldData.slice(), newData.slice(), {
    signal,
    maxInputBytes: MAX_GENERATE_INPUT_BYTES,
    maxOutputBytes: MAX_PATCH_OUTPUT_BYTES,
  });
  const patch = await diffJob.result;
  assertSize(patch, MAX_PATCH_OUTPUT_BYTES, "patch");
  const verification = await verifyPatchBytes(oldData, patch, newData, signal);
  if (!verification.verified) throw new Error("Generated patch did not restore the target byte-for-byte.");
  return { patch, verification, baselineSha256: await sha256Hex(oldData), targetSha256: await sha256Hex(newData) };
}

export async function applyPatchAndVerify(oldData: Uint8Array, patchData: Uint8Array, expectedData?: Uint8Array, signal?: AbortSignal): Promise<{ output: Uint8Array; verification: PatchVerificationResult | null }> {
  assertSize(oldData, MAX_GENERATE_INPUT_BYTES, "baseline");
  assertSize(patchData, MAX_PATCH_INPUT_BYTES, "patch");
  if (expectedData) assertSize(expectedData, MAX_PATCH_OUTPUT_BYTES, "target");
  const job = startPatchBytes(oldData.slice(), patchData.slice(), { signal, maxInputBytes: MAX_PATCH_INPUT_BYTES, maxOutputBytes: MAX_PATCH_OUTPUT_BYTES });
  const output = await job.result;
  if (!expectedData) return { output, verification: null };
  const verification = await verifyPatchBytes(oldData, patchData, expectedData, signal);
  if (!verification.verified) throw new Error("Patch output did not match the expected target.");
  return { output, verification };
}

export async function verifyPatchBytes(oldData: Uint8Array, patchData: Uint8Array, expectedData: Uint8Array, signal?: AbortSignal): Promise<PatchVerificationResult> {
  assertSize(oldData, MAX_GENERATE_INPUT_BYTES, "baseline");
  assertSize(patchData, MAX_PATCH_INPUT_BYTES, "patch");
  assertSize(expectedData, MAX_PATCH_OUTPUT_BYTES, "target");
  return verifyPatch(oldData.slice(), patchData.slice(), expectedData.slice(), { signal, maxInputBytes: MAX_PATCH_INPUT_BYTES, maxOutputBytes: MAX_PATCH_OUTPUT_BYTES });
}

export async function inspectPatchSafely(patchData: Uint8Array): Promise<PatchMetadata> {
  assertSize(patchData, MAX_PATCH_INPUT_BYTES, "patch");
  return inspectPatch(patchData.slice(), { maxInputBytes: MAX_PATCH_INPUT_BYTES });
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function makePatchManifest(baseline: Uint8Array, patch: Uint8Array, target: Uint8Array, names: { baseline?: string; patch?: string; target?: string } = {}): Promise<PatchManifest> {
  const artifact = async (data: Uint8Array, name?: string): Promise<PatchArtifact> => ({ bytes: data.byteLength, sha256: await sha256Hex(data), ...(name ? { name } : {}) });
  return createPatchManifest({ baseline: await artifact(baseline, names.baseline), patch: await artifact(patch, names.patch), target: await artifact(target, names.target) });
}

export function makePatchBundle(target: PatchArtifact, full: PatchArtifact, patches: PatchBundle["patches"] = []): PatchBundle {
  return createPatchBundle({ target, full, patches });
}

export function manifestJson(manifest: PatchManifest): string {
  return canonicalJson(manifest);
}

export async function planPatches(target: Uint8Array, baselines: ReadonlyArray<{ name: string; data: Uint8Array }>, maxPatchRatio = 0.8, signal?: AbortSignal): Promise<PatchPlanItem[]> {
  if (baselines.length > 8) throw new Error("A release plan may contain at most 8 baselines.");
  assertSize(target, MAX_GENERATE_INPUT_BYTES, "target");
  const results: PatchPlanItem[] = [];
  for (const baseline of baselines) {
    try {
      const result = await generateVerifiedPatch(baseline.data, target, signal);
      results.push({ baselineName: baseline.name, status: "verified", patch: result.patch, ratio: target.byteLength === 0 ? 0 : result.patch.byteLength / target.byteLength, error: null });
      const latest = results[results.length - 1];
      if (latest.ratio !== null && latest.ratio > maxPatchRatio) latest.status = "failed";
    } catch (error) {
      results.push({ baselineName: baseline.name, status: "failed", patch: null, ratio: null, error: classifyPatchError(error) });
    }
  }
  return results;
}

function assertSize(data: Uint8Array, max: number, role: string): void {
  if (data.byteLength > max) throw new Error(`${role} exceeds the ${max} byte safety budget.`);
}
