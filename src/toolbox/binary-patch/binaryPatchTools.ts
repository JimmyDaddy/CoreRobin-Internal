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
import { strToU8, zipSync } from "fflate";

export const MAX_GENERATE_INPUT_BYTES = 16 * 1024 * 1024;
export const MAX_PATCH_INPUT_BYTES = 64 * 1024 * 1024;
export const MAX_PATCH_OUTPUT_BYTES = 64 * 1024 * 1024;
export const PATCH_ITEM_DEADLINE_MS = 120_000;
export const PATCH_PLANNER_DEADLINE_MS = 600_000;
export const MAX_PLANNER_ARTIFACT_BYTES = 512 * 1024 * 1024;
export const MAX_PLANNER_WORKING_SET_BYTES = 512 * 1024 * 1024;
export const MAX_PATCH_COLLECTION_BYTES = 512 * 1024 * 1024;
export const PATCH_COLLECTION_FILENAME = "corerobin-patch-collection.zip";
export const PATCH_COLLECTION_PLAN_NAME = "patch-plan.json";

export type PatchInputRole = "baseline" | "target" | "patch" | "expected";

export const PATCH_INPUT_LIMITS: Readonly<Record<PatchInputRole, number>> = {
  baseline: MAX_GENERATE_INPUT_BYTES,
  target: MAX_GENERATE_INPUT_BYTES,
  patch: MAX_PATCH_INPUT_BYTES,
  expected: MAX_PATCH_OUTPUT_BYTES,
};

export interface VerifiedPatch {
  patch: Uint8Array;
  verification: PatchVerificationResult;
  baselineSha256: string;
  targetSha256: string;
}

export interface PatchPlanItem {
  baselineName: string;
  baselineBytes: number | null;
  baselineSha256: string | null;
  status: "verified" | "failed";
  patch: Uint8Array | null;
  ratio: number | null;
  reason: "baseline_read_failed" | "ratio_exceeded" | "patch_generation_failed" | null;
  error: ClassifiedPatchError | null;
}

export interface ExcludedPatchPlanItem {
  baselineName: string;
  patchBytes: number;
  reason: "artifact_budget" | "working_set_budget";
}

export interface PatchBaselineSource {
  name: string;
  load: (signal: AbortSignal) => Promise<Uint8Array>;
}

export interface PatchPlan {
  results: PatchPlanItem[];
  excluded: ExcludedPatchPlanItem[];
  artifactBytes: number;
  artifactLimitBytes: number;
  workingSetBytes: number;
  workingSetLimitBytes: number;
}

export interface PatchCollection {
  bytes: Uint8Array;
  plan: PatchCollectionPlan;
  filename: typeof PATCH_COLLECTION_FILENAME;
}

export interface PatchCollectionPlan extends PatchBundle {
  planning: {
    results: Array<{
      baselineName: string;
      baselineBytes: number | null;
      baselineSha256: string | null;
      status: PatchPlanItem["status"];
      patchBytes: number | null;
      ratio: number | null;
      reason: PatchPlanItem["reason"];
      error: Pick<ClassifiedPatchError, "category" | "code"> | null;
    }>;
    excluded: Array<ExcludedPatchPlanItem>;
  };
}

export interface TransferSavings {
  fullBytes: number;
  patchBytes: number;
  savedBytes: number;
  savingsPercent: number | null;
}

/**
 * Estimate the planner's peak live byte set, including the input arrays held by
 * the caller and the copies made around the diff/patch/verification workers.
 * `artifactBytes` includes the candidate patch when evaluating a result.
 */
export function estimatePlannerWorkingSetBytes(targetBytes: number, residentBaselineBytes: number, currentBaselineBytes: number, patchBytes: number, artifactBytes: number): number {
  const values = [targetBytes, residentBaselineBytes, currentBaselineBytes, patchBytes, artifactBytes];
  if (!values.every((value) => Number.isSafeInteger(value) && value >= 0)) throw new Error("Planner working-set sizes must be non-negative safe integers.");
  const terms = [
    targetBytes,
    residentBaselineBytes,
    artifactBytes,
    targetBytes * 3,
    currentBaselineBytes * 2,
    patchBytes * 2,
  ];
  let total = 0;
  for (const term of terms) {
    if (!Number.isSafeInteger(term) || total > Number.MAX_SAFE_INTEGER - term) return Number.MAX_SAFE_INTEGER;
    total += term;
  }
  return total;
}

export async function generateVerifiedPatch(oldData: Uint8Array, newData: Uint8Array, signal?: AbortSignal): Promise<VerifiedPatch> {
  assertSizeForRole(oldData, "baseline");
  assertSizeForRole(newData, "target");
  return runWithPatchDeadline(async (deadlineSignal) => {
    const diffJob = startDiffBytes(oldData.slice(), newData.slice(), {
      signal: deadlineSignal,
      maxInputBytes: MAX_GENERATE_INPUT_BYTES,
      maxOutputBytes: MAX_PATCH_OUTPUT_BYTES,
    });
    const patch = await diffJob.result;
    assertSizeForRole(patch, "patch");
    const applied = await applyPatchAndVerify(oldData, patch, newData, deadlineSignal);
    const verification = applied.verification;
    if (!verification || !applied.byteExact) throw patchError("EVERIFICATION", "Generated patch did not restore the target byte-for-byte.");
    return { patch, verification, baselineSha256: await sha256Hex(oldData), targetSha256: await sha256Hex(newData) };
  }, signal, PATCH_ITEM_DEADLINE_MS);
}

export async function applyPatchAndVerify(oldData: Uint8Array, patchData: Uint8Array, expectedData?: Uint8Array, signal?: AbortSignal): Promise<{ output: Uint8Array; verification: PatchVerificationResult | null; byteExact: boolean }> {
  assertSizeForRole(oldData, "baseline");
  assertSizeForRole(patchData, "patch");
  if (expectedData) assertSizeForRole(expectedData, "expected");
  return runWithPatchDeadline(async (deadlineSignal) => {
    const metadata = await inspectPatchSafely(patchData);
    assertSupportedPatch(metadata);
    const job = startPatchBytes(oldData.slice(), patchData.slice(), { signal: deadlineSignal, maxInputBytes: MAX_PATCH_INPUT_BYTES, maxOutputBytes: MAX_PATCH_OUTPUT_BYTES });
    const output = await job.result;
    assertSizeForRole(output, "expected");
    if (!expectedData) return { output, verification: null, byteExact: false };
    const verification = await verifyPatch(oldData.slice(), patchData.slice(), expectedData.slice(), { signal: deadlineSignal, maxInputBytes: MAX_PATCH_INPUT_BYTES, maxOutputBytes: MAX_PATCH_OUTPUT_BYTES });
    const byteExact = compareBytes(output, expectedData);
    if (!verification.verified || !byteExact) throw patchError("EVERIFICATION", "Patch output did not match the expected target byte-for-byte.");
    return { output, verification, byteExact };
  }, signal, PATCH_ITEM_DEADLINE_MS);
}

export async function verifyPatchBytes(oldData: Uint8Array, patchData: Uint8Array, expectedData: Uint8Array, signal?: AbortSignal): Promise<PatchVerificationResult> {
  assertSizeForRole(oldData, "baseline");
  assertSizeForRole(patchData, "patch");
  assertSizeForRole(expectedData, "expected");
  return runWithPatchDeadline(async (deadlineSignal) => {
    const metadata = await inspectPatchSafely(patchData);
    assertSupportedPatch(metadata);
    const verification = await verifyPatch(oldData.slice(), patchData.slice(), expectedData.slice(), { signal: deadlineSignal, maxInputBytes: MAX_PATCH_INPUT_BYTES, maxOutputBytes: MAX_PATCH_OUTPUT_BYTES });
    const replay = await startPatchBytes(oldData.slice(), patchData.slice(), { signal: deadlineSignal, maxInputBytes: MAX_PATCH_INPUT_BYTES, maxOutputBytes: MAX_PATCH_OUTPUT_BYTES }).result;
    if (!verification.verified || !compareBytes(replay, expectedData)) throw patchError("EVERIFICATION", "Patch replay did not match the expected target byte-for-byte.");
    return verification;
  }, signal, PATCH_ITEM_DEADLINE_MS);
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
  assertSizeForRole(target, "target");
  for (const baseline of baselines) assertSizeForRole(baseline.data, "baseline");
  return planPatchSources(target, baselines.map((baseline) => ({ name: baseline.name, load: async () => baseline.data })), maxPatchRatio, signal, artifactBudgetBytes, baselines.reduce((total, baseline) => total + baseline.data.byteLength, 0));
}

export async function planPatchesFromSources(target: Uint8Array, baselines: ReadonlyArray<PatchBaselineSource>, maxPatchRatio = 0.8, signal?: AbortSignal, artifactBudgetBytes = MAX_PLANNER_ARTIFACT_BYTES): Promise<PatchPlan> {
  if (baselines.length > 8) throw new Error("A release plan may contain at most 8 baselines.");
  assertSizeForRole(target, "target");
  return planPatchSources(target, baselines, maxPatchRatio, signal, artifactBudgetBytes, null);
}

async function planPatchSources(target: Uint8Array, baselines: ReadonlyArray<PatchBaselineSource>, maxPatchRatio: number, signal: AbortSignal | undefined, artifactBudgetBytes: number, knownBaselineBytes: number | null): Promise<PatchPlan> {
  if (!Number.isSafeInteger(artifactBudgetBytes) || artifactBudgetBytes < 0 || artifactBudgetBytes > MAX_PLANNER_ARTIFACT_BYTES) throw new Error("Planner artifact budget is invalid.");
  if (!Number.isFinite(maxPatchRatio) || maxPatchRatio < 0) throw new Error("Patch ratio threshold is invalid.");
  return runWithPatchDeadline(async (plannerSignal) => {
    const results: PatchPlanItem[] = [];
    const excluded: ExcludedPatchPlanItem[] = [];
    let artifactBytes = 0;
    let peakWorkingSetBytes = estimatePlannerWorkingSetBytes(target.byteLength, knownBaselineBytes ?? 0, 0, 0, artifactBytes);
    for (const baseline of baselines) {
      let baselineData: Uint8Array;
      try {
        baselineData = await baseline.load(plannerSignal);
        assertSizeForRole(baselineData, "baseline");
      } catch (error) {
        if (isPatchTaskCancelled(error)) throw error;
        results.push({ baselineName: baseline.name, baselineBytes: null, baselineSha256: null, status: "failed", patch: null, ratio: null, reason: "baseline_read_failed", error: classifyPatchError(error) });
        continue;
      }
      const residentBaselineBytes = knownBaselineBytes ?? baselineData.byteLength;
      peakWorkingSetBytes = Math.max(peakWorkingSetBytes, estimatePlannerWorkingSetBytes(target.byteLength, residentBaselineBytes, baselineData.byteLength, 0, artifactBytes));
      try {
        const result = await generateVerifiedPatch(baselineData, target, plannerSignal);
        const ratio = target.byteLength === 0 ? 0 : result.patch.byteLength / target.byteLength;
        const nextArtifactBytes = artifactBytes + result.patch.byteLength;
        const observedWorkingSetBytes = estimatePlannerWorkingSetBytes(target.byteLength, residentBaselineBytes, baselineData.byteLength, result.patch.byteLength, Number.isSafeInteger(nextArtifactBytes) ? nextArtifactBytes : Number.MAX_SAFE_INTEGER);
        peakWorkingSetBytes = Math.max(peakWorkingSetBytes, observedWorkingSetBytes);
        if (ratio > maxPatchRatio) {
          results.push({ baselineName: baseline.name, baselineBytes: baselineData.byteLength, baselineSha256: result.baselineSha256, status: "failed", patch: null, ratio, reason: "ratio_exceeded", error: null });
          continue;
        }
        if (!Number.isSafeInteger(nextArtifactBytes) || nextArtifactBytes > artifactBudgetBytes) {
          excluded.push({ baselineName: baseline.name, patchBytes: result.patch.byteLength, reason: "artifact_budget" });
          continue;
        }
        if (observedWorkingSetBytes > MAX_PLANNER_WORKING_SET_BYTES) {
          excluded.push({ baselineName: baseline.name, patchBytes: result.patch.byteLength, reason: "working_set_budget" });
          continue;
        }
        artifactBytes = nextArtifactBytes;
        results.push({ baselineName: baseline.name, baselineBytes: baselineData.byteLength, baselineSha256: result.baselineSha256, status: "verified", patch: result.patch, ratio, reason: null, error: null });
      } catch (error) {
        if (isPatchTaskCancelled(error)) throw error;
        results.push({ baselineName: baseline.name, baselineBytes: baselineData.byteLength, baselineSha256: null, status: "failed", patch: null, ratio: null, reason: "patch_generation_failed", error: classifyPatchError(error) });
      }
    }
    return {
      results,
      excluded,
      artifactBytes,
      artifactLimitBytes: artifactBudgetBytes,
      workingSetBytes: peakWorkingSetBytes,
      workingSetLimitBytes: MAX_PLANNER_WORKING_SET_BYTES,
    };
  }, signal, PATCH_PLANNER_DEADLINE_MS);
}

export async function inspectPatchSafely(patchData: Uint8Array): Promise<PatchMetadata> {
  assertSizeForRole(patchData, "patch");
  return inspectPatch(patchData.slice(), { maxInputBytes: MAX_PATCH_INPUT_BYTES });
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function makePatchManifest(baseline: Uint8Array, patch: Uint8Array, target: Uint8Array, names: { baseline?: string; patch?: string; target?: string } = {}): Promise<PatchManifest> {
  assertSizeForRole(baseline, "baseline");
  assertSizeForRole(patch, "patch");
  assertSizeForRole(target, "target");
  const artifact = async (data: Uint8Array, name?: string): Promise<PatchArtifact> => ({ bytes: data.byteLength, sha256: await sha256Hex(data), ...(name ? { name: safeArtifactName(name) } : {}) });
  return createPatchManifest({ baseline: await artifact(baseline, names.baseline), patch: await artifact(patch, names.patch), target: await artifact(target, names.target) });
}

export function makePatchBundle(target: PatchArtifact, full: PatchArtifact, patches: PatchBundle["patches"] = []): PatchBundle {
  return createPatchBundle({ target, full, patches });
}

export async function createPatchCollection(target: { name: string; data: Uint8Array }, plan: PatchPlan, maxCollectionBytes = MAX_PATCH_COLLECTION_BYTES): Promise<PatchCollection> {
  if (!Number.isSafeInteger(maxCollectionBytes) || maxCollectionBytes <= 0 || maxCollectionBytes > MAX_PATCH_COLLECTION_BYTES) {
    throw new Error("Patch collection budget is invalid.");
  }
  assertSizeForRole(target.data, "target");
  const targetName = safeArtifactName(target.name);
  const fullPath = `full/${targetName}`;
  const targetArtifact: PatchArtifact = {
    bytes: target.data.byteLength,
    sha256: await sha256Hex(target.data),
    name: targetName,
    url: fullPath,
  };
  const patches: PatchBundle["patches"] = [];
  const entries: Record<string, Uint8Array> = { [fullPath]: target.data.slice() };

  for (const [index, item] of plan.results.entries()) {
    if (item.status !== "verified" || !item.patch || item.baselineBytes === null || item.baselineSha256 === null) continue;
    const baselineName = safeArtifactName(item.baselineName);
    const patchName = `${String(index + 1).padStart(2, "0")}-${baselineName}.endsley.patch`;
    const patchPath = `patches/${patchName}`;
    entries[patchPath] = item.patch.slice();
    patches.push({
      format: "ENDSLEY/BSDIFF43",
      baseline: { bytes: item.baselineBytes, sha256: item.baselineSha256, name: baselineName },
      patch: { bytes: item.patch.byteLength, sha256: await sha256Hex(item.patch), name: patchName, url: patchPath },
      declaredTargetBytes: String(target.data.byteLength),
    });
  }

  const bundle = makePatchBundle(targetArtifact, targetArtifact, patches);
  const collectionPlan: PatchCollectionPlan = {
    ...bundle,
    planning: {
      results: plan.results.map((item) => ({
        baselineName: safeArtifactName(item.baselineName),
        baselineBytes: item.baselineBytes,
        baselineSha256: item.baselineSha256,
        status: item.status,
        patchBytes: item.patch?.byteLength ?? null,
        ratio: item.ratio,
        reason: item.reason,
        error: item.error ? { category: item.error.category, code: item.error.code } : null,
      })),
      excluded: plan.excluded.map((item) => ({ ...item, baselineName: safeArtifactName(item.baselineName) })),
    },
  };
  entries[PATCH_COLLECTION_PLAN_NAME] = strToU8(manifestJson(collectionPlan));
  const bytes = zipSync(entries, { level: 6 });
  if (bytes.byteLength > maxCollectionBytes) {
    throw patchError("ERESOURCE", `The final patch collection exceeds the ${maxCollectionBytes} byte safety budget.`);
  }
  return { bytes, plan: collectionPlan, filename: PATCH_COLLECTION_FILENAME };
}

export function manifestJson(manifest: unknown): string {
  return canonicalJson(manifest);
}

export function patchInputLimit(role: PatchInputRole): number {
  return PATCH_INPUT_LIMITS[role];
}

export function compareBytes(actual: Uint8Array, expected: Uint8Array): boolean {
  if (actual.byteLength !== expected.byteLength) return false;
  for (let index = 0; index < actual.byteLength; index += 1) if (actual[index] !== expected[index]) return false;
  return true;
}

function assertSizeForRole(data: Uint8Array, role: PatchInputRole): void {
  assertSize(data, patchInputLimit(role), role);
}

function assertSize(data: Uint8Array, max: number, role: string): void {
  if (data.byteLength > max) throw patchError("ERESOURCE", `${role} exceeds the ${max} byte safety budget.`);
}

function assertSupportedPatch(metadata: PatchMetadata): void {
  if (metadata.format === "BSDIFF40") throw patchError("EPATCH", "BSDIFF40 is inspect-only; it is never applied by the web tool.");
  if (metadata.format !== "ENDSLEY/BSDIFF43" || !metadata.valid) throw patchError("EPATCH", "Only a valid ENDSLEY/BSDIFF43 patch may be applied.");
}

function patchError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function safeArtifactName(name: string): string {
  const basename = name.replace(/\\/g, "/").split("/").pop() ?? "artifact";
  let safe = "";
  for (const character of basename) {
    const code = character.charCodeAt(0);
    safe += code <= 0x1f || code === 0x7f ? "_" : character;
  }
  safe = safe.trim();
  return safe === "." || safe === ".." || safe.length === 0 ? "artifact" : safe;
}
