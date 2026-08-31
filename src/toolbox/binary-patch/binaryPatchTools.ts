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
export const PATCH_ITEM_DEADLINE_MS = 120_000;
export const PATCH_PLANNER_DEADLINE_MS = 600_000;
export const MAX_PLANNER_ARTIFACT_BYTES = 512 * 1024 * 1024;

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

export interface ExcludedPatchPlanItem {
  baselineName: string;
  patchBytes: number;
  reason: "artifact_budget";
}

export interface PatchPlan {
  results: PatchPlanItem[];
  excluded: ExcludedPatchPlanItem[];
  artifactBytes: number;
  artifactLimitBytes: number;
}

export interface TransferSavings {
  fullBytes: number;
  patchBytes: number;
  savedBytes: number;
  savingsPercent: number | null;
}

export async function generateVerifiedPatch(oldData: Uint8Array, newData: Uint8Array, signal?: AbortSignal): Promise<VerifiedPatch> {
  assertSize(oldData, MAX_GENERATE_INPUT_BYTES, "baseline");
  assertSize(newData, MAX_GENERATE_INPUT_BYTES, "target");
  return runWithPatchDeadline(async (deadlineSignal) => {
    const diffJob = startDiffBytes(oldData.slice(), newData.slice(), {
      signal: deadlineSignal,
      maxInputBytes: MAX_GENERATE_INPUT_BYTES,
      maxOutputBytes: MAX_PATCH_OUTPUT_BYTES,
    });
    const patch = await diffJob.result;
    assertSize(patch, MAX_PATCH_OUTPUT_BYTES, "patch");
    const verification = await verifyPatchBytes(oldData, patch, newData, deadlineSignal);
    if (!verification.verified) throw new Error("Generated patch did not restore the target byte-for-byte.");
    return { patch, verification, baselineSha256: await sha256Hex(oldData), targetSha256: await sha256Hex(newData) };
  }, signal, PATCH_ITEM_DEADLINE_MS);
}

export async function applyPatchAndVerify(oldData: Uint8Array, patchData: Uint8Array, expectedData?: Uint8Array, signal?: AbortSignal): Promise<{ output: Uint8Array; verification: PatchVerificationResult | null }> {
  assertSize(oldData, MAX_GENERATE_INPUT_BYTES, "baseline");
  assertSize(patchData, MAX_PATCH_INPUT_BYTES, "patch");
  if (expectedData) assertSize(expectedData, MAX_PATCH_OUTPUT_BYTES, "target");
  return runWithPatchDeadline(async (deadlineSignal) => {
    const job = startPatchBytes(oldData.slice(), patchData.slice(), { signal: deadlineSignal, maxInputBytes: MAX_PATCH_INPUT_BYTES, maxOutputBytes: MAX_PATCH_OUTPUT_BYTES });
    const output = await job.result;
    if (!expectedData) return { output, verification: null };
    const verification = await verifyPatchBytes(oldData, patchData, expectedData, deadlineSignal);
    if (!verification.verified) throw new Error("Patch output did not match the expected target.");
    return { output, verification };
  }, signal, PATCH_ITEM_DEADLINE_MS);
}

export async function verifyPatchBytes(oldData: Uint8Array, patchData: Uint8Array, expectedData: Uint8Array, signal?: AbortSignal): Promise<PatchVerificationResult> {
  assertSize(oldData, MAX_GENERATE_INPUT_BYTES, "baseline");
  assertSize(patchData, MAX_PATCH_INPUT_BYTES, "patch");
  assertSize(expectedData, MAX_PATCH_OUTPUT_BYTES, "target");
  return runWithPatchDeadline((deadlineSignal) => verifyPatch(oldData.slice(), patchData.slice(), expectedData.slice(), { signal: deadlineSignal, maxInputBytes: MAX_PATCH_INPUT_BYTES, maxOutputBytes: MAX_PATCH_OUTPUT_BYTES }), signal, PATCH_ITEM_DEADLINE_MS);
}

export async function runWithPatchDeadline<T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal, deadlineMs = PATCH_ITEM_DEADLINE_MS): Promise<T> {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) throw new Error("Patch deadline must be a positive safe integer.");
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  signal?.addEventListener("abort", abortFromCaller, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  let rejectWhenCancelled: (reason: Error) => void = () => undefined;
  const cancelled = new Promise<never>((_resolve, reject) => { rejectWhenCancelled = reject; });
  const abortOperation = () => rejectWhenCancelled(cancelledPatchTaskError());
  controller.signal.addEventListener("abort", abortOperation, { once: true });
  try {
    if (controller.signal.aborted) throw cancelledPatchTaskError();
    return await Promise.race([operation(controller.signal), cancelled]);
  } catch (error) {
    if (controller.signal.aborted || isPatchTaskCancelled(error)) throw cancelledPatchTaskError();
    throw error;
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", abortOperation);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}

export function isPatchTaskCancelled(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; name?: unknown };
  return candidate.name === "AbortError" || candidate.code === "EABORTED" || candidate.code === "ECANCELLED";
}

export function calculateTransferSavings(full: number, patch: number, count: number): TransferSavings {
  if (![full, patch, count].every((value) => Number.isFinite(value) && Number.isSafeInteger(value) && value >= 0)) {
    throw new Error("大小和次数必须是非负安全整数。");
  }
  const fullBytes = full * count;
  const patchBytes = patch * count;
  if (![fullBytes, patchBytes].every((value) => Number.isFinite(value) && Number.isSafeInteger(value))) {
    throw new Error("累计传输大小超出安全整数范围。");
  }
  const savedBytes = fullBytes - patchBytes;
  const savingsPercent = fullBytes === 0 ? null : (savedBytes / fullBytes) * 100;
  if (savingsPercent !== null && !Number.isFinite(savingsPercent)) throw new Error("节省比例不是有限数值。");
  return { fullBytes, patchBytes, savedBytes, savingsPercent };
}

function cancelledPatchTaskError(): Error & { code: "EABORTED" } {
  const error = new Error("Binary patch task was cancelled.") as Error & { code: "EABORTED" };
  error.name = "AbortError";
  error.code = "EABORTED";
  return error;
}

export async function planPatches(target: Uint8Array, baselines: ReadonlyArray<{ name: string; data: Uint8Array }>, maxPatchRatio = 0.8, signal?: AbortSignal, artifactBudgetBytes = MAX_PLANNER_ARTIFACT_BYTES): Promise<PatchPlan> {
  if (baselines.length > 8) throw new Error("A release plan may contain at most 8 baselines.");
  if (!Number.isSafeInteger(artifactBudgetBytes) || artifactBudgetBytes < 0 || artifactBudgetBytes > MAX_PLANNER_ARTIFACT_BYTES) throw new Error("Planner artifact budget is invalid.");
  assertSize(target, MAX_GENERATE_INPUT_BYTES, "target");
  return runWithPatchDeadline(async (plannerSignal) => {
    const results: PatchPlanItem[] = [];
    const excluded: ExcludedPatchPlanItem[] = [];
    let artifactBytes = 0;
    for (const baseline of baselines) {
      try {
        const result = await generateVerifiedPatch(baseline.data, target, plannerSignal);
        const ratio = target.byteLength === 0 ? 0 : result.patch.byteLength / target.byteLength;
        if (ratio > maxPatchRatio) {
          results.push({ baselineName: baseline.name, status: "failed", patch: null, ratio, error: null });
          continue;
        }
        const nextArtifactBytes = artifactBytes + result.patch.byteLength;
        if (!Number.isSafeInteger(nextArtifactBytes) || nextArtifactBytes > artifactBudgetBytes) {
          excluded.push({ baselineName: baseline.name, patchBytes: result.patch.byteLength, reason: "artifact_budget" });
          continue;
        }
        artifactBytes = nextArtifactBytes;
        results.push({ baselineName: baseline.name, status: "verified", patch: result.patch, ratio, error: null });
      } catch (error) {
        if (isPatchTaskCancelled(error)) throw error;
        results.push({ baselineName: baseline.name, status: "failed", patch: null, ratio: null, error: classifyPatchError(error) });
      }
    }
    return { results, excluded, artifactBytes, artifactLimitBytes: artifactBudgetBytes };
  }, signal, PATCH_PLANNER_DEADLINE_MS);
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

function assertSize(data: Uint8Array, max: number, role: string): void {
  if (data.byteLength > max) throw new Error(`${role} exceeds the ${max} byte safety budget.`);
}
