import type { CleanupDeleteFailure, CleanupDeleteMode } from "./types";

export interface CleanupDeleteOutcome {
  deletedCount: number;
  deletedBytes: number;
  selectedLogicalBytes: number;
  selectedAllocatedBytes: number;
  availableBytesBefore: number | null;
  availableBytesAfter: number | null;
  mode: CleanupDeleteMode;
  failed: CleanupDeleteFailure[];
  cancelled: boolean;
}

export function cleanupAvailableDelta(outcome: CleanupDeleteOutcome): number {
  if (outcome.availableBytesBefore === null || outcome.availableBytesAfter === null) return 0;
  return Math.max(0, outcome.availableBytesAfter - outcome.availableBytesBefore);
}

export function cleanupOutcomeStatus(outcome: CleanupDeleteOutcome) {
  if (outcome.cancelled) return "cancelled";
  if (outcome.failed.length > 0) return outcome.deletedCount > 0 ? "partial" : "failed";
  return outcome.deletedCount > 0 ? "success" : "empty";
}
