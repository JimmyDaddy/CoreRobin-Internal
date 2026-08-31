export const PATCH_OUTPUT_TTL_MS = 10 * 60 * 1000;

export type BinaryPatchTaskState =
  | "idle"
  | "queued"
  | "running"
  | "stopping"
  | "output_ready"
  | "exporting"
  | "completed"
  | "cancelled"
  | "expired"
  | "failed";

export interface BinaryPatchTaskSnapshot {
  state: BinaryPatchTaskState;
  generation: number;
  resetEpoch: number;
  outputToken: string | null;
  outputExpiresAt: number | null;
  verified: boolean | null;
  retryable: boolean;
  errorCode: string | null;
}

export interface PatchTaskFailure {
  code: string;
  retryable: boolean;
}

export function createPatchTaskSnapshot(resetEpoch = 0): BinaryPatchTaskSnapshot {
  return {
    state: "idle",
    generation: 0,
    resetEpoch,
    outputToken: null,
    outputExpiresAt: null,
    verified: null,
    retryable: false,
    errorCode: null,
  };
}

export function queuePatchTask(previous: BinaryPatchTaskSnapshot, resetEpoch = previous.resetEpoch): BinaryPatchTaskSnapshot {
  return {
    state: "queued",
    generation: previous.generation + 1,
    resetEpoch,
    outputToken: null,
    outputExpiresAt: null,
    verified: null,
    retryable: false,
    errorCode: null,
  };
}

export function markPatchRunning(snapshot: BinaryPatchTaskSnapshot): BinaryPatchTaskSnapshot {
  return { ...snapshot, state: "running", errorCode: null, retryable: false };
}

export function markPatchStopping(snapshot: BinaryPatchTaskSnapshot): BinaryPatchTaskSnapshot {
  return { ...snapshot, state: "stopping" };
}

export function markPatchOutputReady(
  snapshot: BinaryPatchTaskSnapshot,
  verified: boolean,
  now = Date.now(),
  outputToken: string | null = null,
  ttlMs = PATCH_OUTPUT_TTL_MS,
): BinaryPatchTaskSnapshot {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("Patch task clock must be a non-negative safe integer.");
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error("Patch output TTL must be a positive safe integer.");
  return {
    ...snapshot,
    state: "output_ready",
    outputToken,
    outputExpiresAt: now + ttlMs,
    verified,
    retryable: false,
    errorCode: null,
  };
}

export function markPatchExporting(snapshot: BinaryPatchTaskSnapshot, generation = snapshot.generation, resetEpoch = snapshot.resetEpoch): BinaryPatchTaskSnapshot {
  assertCurrentPatchResult(snapshot, generation, resetEpoch);
  if (snapshot.state !== "output_ready") throw new Error("Only an output_ready patch can enter exporting.");
  if (isPatchOutputExpired(snapshot)) throw new Error("Patch output has expired.");
  return { ...snapshot, state: "exporting" };
}

export function markPatchCompleted(snapshot: BinaryPatchTaskSnapshot, generation = snapshot.generation, resetEpoch = snapshot.resetEpoch): BinaryPatchTaskSnapshot {
  assertCurrentPatchResult(snapshot, generation, resetEpoch);
  if (snapshot.state !== "exporting") throw new Error("Only an exporting patch can complete.");
  return { ...snapshot, state: "completed" };
}

export function markPatchCancelled(snapshot: BinaryPatchTaskSnapshot): BinaryPatchTaskSnapshot {
  return { ...snapshot, state: "cancelled", outputToken: null, outputExpiresAt: null, verified: null, retryable: false, errorCode: "EABORTED" };
}

export function markPatchFailure(snapshot: BinaryPatchTaskSnapshot, failure: PatchTaskFailure): BinaryPatchTaskSnapshot {
  return { ...snapshot, state: "failed", outputToken: null, outputExpiresAt: null, verified: null, retryable: failure.retryable, errorCode: failure.code };
}

export function expirePatchOutput(snapshot: BinaryPatchTaskSnapshot, now = Date.now()): BinaryPatchTaskSnapshot {
  if (snapshot.state !== "output_ready" && snapshot.state !== "exporting") return snapshot;
  if (snapshot.outputExpiresAt === null || now < snapshot.outputExpiresAt) return snapshot;
  return { ...snapshot, state: "expired", outputToken: null, outputExpiresAt: null, verified: null, retryable: false, errorCode: "EEXPIRED" };
}

export function isPatchOutputExpired(snapshot: BinaryPatchTaskSnapshot, now = Date.now()): boolean {
  return snapshot.outputExpiresAt !== null && now >= snapshot.outputExpiresAt;
}

export function canRetryPatch(snapshot: BinaryPatchTaskSnapshot, now = Date.now()): boolean {
  return snapshot.state === "failed" && snapshot.retryable && !isPatchOutputExpired(snapshot, now);
}

export function assertCurrentPatchResult(snapshot: BinaryPatchTaskSnapshot, generation: number, resetEpoch: number): void {
  if (snapshot.generation !== generation || snapshot.resetEpoch !== resetEpoch) {
    throw new Error("Patch result belongs to an earlier task generation or reset epoch.");
  }
}
