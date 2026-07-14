import type { CleanupPathState } from "./types";

export function cleanupPathChanged(
  state: CleanupPathState,
  sampledAtMs: number,
): boolean {
  return !state.exists || (
    state.modifiedAtMs !== null &&
    state.modifiedAtMs > sampledAtMs
  );
}
