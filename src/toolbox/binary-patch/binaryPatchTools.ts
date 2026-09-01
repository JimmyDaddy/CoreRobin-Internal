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
import { strToU8, Zip, ZipPassThrough } from "fflate";

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
const PATCH_COLLECTION_STREAM_CHUNK_BYTES = 1024 * 1024;

export type PatchInputRole = "baseline" | "target" | "patch" | "expected";
export type PatchDeadlineToolId = "binary-patch-create" | "binary-patch-apply" | "binary-patch-inspector" | "integrity-manifest" | "transfer-savings" | "patch-errors" | "patch-planner";

export const PATCH_INPUT_LIMITS: Readonly<Record<PatchInputRole, number>> = {
  baseline: MAX_GENERATE_INPUT_BYTES,
  target: MAX_GENERATE_INPUT_BYTES,
  patch: MAX_PATCH_INPUT_BYTES,
  expected: MAX_PATCH_OUTPUT_BYTES,
};

export function patchDeadlineForTool(toolId: PatchDeadlineToolId): number {
  return toolId === "patch-planner" ? PATCH_PLANNER_DEADLINE_MS : PATCH_ITEM_DEADLINE_MS;
}

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

/**
 * A patch collection keeps its source artifacts resident while the streaming
 * ZIP chunks are waiting to be assembled into the single output buffer that
 * the native output-token API accepts. Count all three byte sets before
 * creating the archive so the final join cannot push the WebView over the
 * product working-set limit.
 */
export function estimatePatchCollectionWorkingSetBytes(sourceBytes: number, archiveBytes: number): number {
  if (![sourceBytes, archiveBytes].every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error("Patch collection working-set sizes must be non-negative safe integers.");
  }
  return safeByteSum([sourceBytes, archiveBytes, archiveBytes]);
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
  let abortKind: "caller" | "deadline" | null = null;
  const abort = (kind: "caller" | "deadline") => {
    if (controller.signal.aborted) return;
    abortKind = kind;
    controller.abort();
  };
  const abortFromCaller = () => abort("caller");
  signal?.addEventListener("abort", abortFromCaller, { once: true });
  if (signal?.aborted) abort("caller");
  const timer = setTimeout(() => abort("deadline"), deadlineMs);
  let rejectWhenCancelled: (reason: Error) => void = () => undefined;
  const cancelled = new Promise<never>((_resolve, reject) => { rejectWhenCancelled = reject; });
  const abortOperation = () => rejectWhenCancelled(abortKind === "deadline" ? deadlinePatchTaskError() : cancelledPatchTaskError());
  controller.signal.addEventListener("abort", abortOperation, { once: true });
  try {
    if (controller.signal.aborted) throw abortKind === "deadline" ? deadlinePatchTaskError() : cancelledPatchTaskError();
    return await Promise.race([operation(controller.signal), cancelled]);
  } catch (error) {
    if (controller.signal.aborted || isPatchTaskCancelled(error) || isPatchTaskTimedOut(error)) {
      throw abortKind === "deadline" || isPatchTaskTimedOut(error) ? deadlinePatchTaskError() : cancelledPatchTaskError();
    }
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

export function isPatchTaskTimedOut(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return (error as { code?: unknown }).code === "EDEADLINE";
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

function deadlinePatchTaskError(): Error & { code: "EDEADLINE" } {
  const error = new Error("Binary patch task exceeded its deadline.") as Error & { code: "EDEADLINE" };
  error.name = "TimeoutError";
  error.code = "EDEADLINE";
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

export async function createPatchCollection(target: { name: string; data: Uint8Array }, plan: PatchPlan, maxCollectionBytes = MAX_PATCH_COLLECTION_BYTES, signal?: AbortSignal): Promise<PatchCollection> {
  if (!Number.isSafeInteger(maxCollectionBytes) || maxCollectionBytes <= 0 || maxCollectionBytes > MAX_PATCH_COLLECTION_BYTES) {
    throw new Error("Patch collection budget is invalid.");
  }
  throwIfAborted(signal);
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
  const entries: PatchCollectionEntry[] = [{ path: fullPath, data: target.data }];

  for (const [index, item] of plan.results.entries()) {
    throwIfAborted(signal);
    if (item.status !== "verified" || !item.patch || item.baselineBytes === null || item.baselineSha256 === null) continue;
    const baselineName = safeArtifactName(item.baselineName);
    const patchName = `${String(index + 1).padStart(2, "0")}-${baselineName}.endsley.patch`;
    const patchPath = `patches/${patchName}`;
    entries.push({ path: patchPath, data: item.patch });
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
  throwIfAborted(signal);
  entries.push({ path: PATCH_COLLECTION_PLAN_NAME, data: strToU8(manifestJson(collectionPlan)) });
  const archiveBytes = estimateStoredZipBytes(entries);
  if (archiveBytes > maxCollectionBytes) throw patchError("ERESOURCE", `The final patch collection exceeds the ${maxCollectionBytes} byte safety budget.`);
  const sourceBytes = safeByteSum(entries.map((entry) => entry.data.byteLength));
  const workingSetBytes = estimatePatchCollectionWorkingSetBytes(sourceBytes, archiveBytes);
  if (workingSetBytes > MAX_PLANNER_WORKING_SET_BYTES) {
    throw patchError("ERESOURCE", `The patch collection would require ${workingSetBytes} bytes, exceeding the ${MAX_PLANNER_WORKING_SET_BYTES} byte working-set safety budget.`);
  }
  const bytes = await createStoredPatchCollection(entries, archiveBytes, signal);
  throwIfAborted(signal);
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

interface PatchCollectionEntry {
  path: string;
  data: Uint8Array;
}

function estimateStoredZipBytes(entries: ReadonlyArray<PatchCollectionEntry>): number {
  let total = 22; // End of central directory.
  for (const entry of entries) {
    const filenameBytes = strToU8(entry.path).byteLength;
    // Local header + data descriptor + central directory header, plus the
    // filename in both headers. ZipPassThrough stores exactly these bytes.
    total = safeByteSum([total, entry.data.byteLength, 92, filenameBytes, filenameBytes]);
  }
  return total;
}

async function createStoredPatchCollection(entries: ReadonlyArray<PatchCollectionEntry>, expectedBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
  throwIfAborted(signal);
  return new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    const archive = new Zip((error, chunk, final) => {
      if (settled) return;
      if (error) {
        finish(error);
        return;
      }
      if (!chunk) {
        finish(patchError("EARCHIVE", "Patch collection streaming returned an empty ZIP chunk."));
        return;
      }
      chunks.push(chunk);
      if (final) void complete();
    });
    let settled = false;
    let activeEntryReject: ((reason: unknown) => void) | null = null;
    const abort = () => finish(cancelledPatchTaskError());
    const finish = (reason: unknown) => {
      if (settled) return;
      settled = true;
      archive.terminate();
      activeEntryReject?.(reason);
      signal?.removeEventListener("abort", abort);
      reject(reason);
    };
    const complete = async () => {
      if (settled) return;
      try {
        throwIfAborted(signal);
        const bytes = await joinZipChunks(chunks, expectedBytes, signal);
        if (bytes.byteLength !== expectedBytes) throw patchError("EARCHIVE", "Patch collection byte accounting did not match the streamed archive.");
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", abort);
        resolve(bytes);
      } catch (error) {
        finish(error);
      }
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    void (async () => {
      try {
        for (const entry of entries) {
          throwIfAborted(signal);
          const file = new ZipPassThrough(entry.path);
          archive.add(file);
          let resolveEntry: () => void = () => undefined;
          const entryCompleted = new Promise<void>((resolve, rejectEntry) => {
            activeEntryReject = rejectEntry;
            const ondata = file.ondata;
            file.ondata = (error, data, final) => {
              ondata(error, data, final);
              if (error) rejectEntry(error);
              else if (final) resolveEntry();
            };
            resolveEntry = resolve;
          });
          for (let offset = 0; offset < entry.data.byteLength; offset += PATCH_COLLECTION_STREAM_CHUNK_BYTES) {
            if (settled) return;
            throwIfAborted(signal);
            const end = Math.min(offset + PATCH_COLLECTION_STREAM_CHUNK_BYTES, entry.data.byteLength);
            file.push(entry.data.subarray(offset, end), end === entry.data.byteLength);
            if (end < entry.data.byteLength) await yieldToEventLoop(signal);
          }
          if (entry.data.byteLength === 0) file.push(entry.data, true);
          await entryCompleted;
          activeEntryReject = null;
          await yieldToEventLoop(signal);
        }
        throwIfAborted(signal);
        archive.end();
      } catch (error) {
        finish(error);
      }
    })();
  });
}

async function joinZipChunks(chunks: ReadonlyArray<Uint8Array>, expectedBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
  const bytes = new Uint8Array(expectedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    for (let chunkOffset = 0; chunkOffset < chunk.byteLength; chunkOffset += PATCH_COLLECTION_STREAM_CHUNK_BYTES) {
      throwIfAborted(signal);
      const end = Math.min(chunkOffset + PATCH_COLLECTION_STREAM_CHUNK_BYTES, chunk.byteLength);
      bytes.set(chunk.subarray(chunkOffset, end), offset);
      offset += end - chunkOffset;
      await yieldToEventLoop(signal);
    }
  }
  return bytes;
}

async function yieldToEventLoop(signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  throwIfAborted(signal);
}

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

function safeByteSum(values: ReadonlyArray<number>): number {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0 || total > Number.MAX_SAFE_INTEGER - value) {
      throw patchError("ERESOURCE", "Patch collection size exceeds the safe byte range.");
    }
    total += value;
  }
  return total;
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
