import { describe, expect, it } from "vitest";
import {
  assertCurrentPatchResult,
  canRetryPatch,
  createPatchTaskSnapshot,
  expirePatchOutput,
  markPatchCancelled,
  markPatchCompleted,
  markPatchExporting,
  markPatchFailure,
  markPatchOutputReady,
  markPatchRunning,
  queuePatchTask,
} from "./binaryPatchLifecycle";

describe("binary patch task lifecycle", () => {
  it("keeps generation/reset epoch and expires output without extending TTL", () => {
    const queued = queuePatchTask(createPatchTaskSnapshot(4), 4);
    const running = markPatchRunning(queued);
    const ready = markPatchOutputReady(running, true, 100, "native-output-token", 10);
    expect(ready).toMatchObject({ state: "output_ready", generation: 1, resetEpoch: 4, outputExpiresAt: 110, outputToken: "native-output-token" });
    expect(expirePatchOutput(ready, 109)).toBe(ready);
    expect(expirePatchOutput(ready, 110)).toMatchObject({ state: "expired", outputToken: null });
  });

  it("only allows a current output through exporting to completed", () => {
    const now = Date.now();
    const ready = markPatchOutputReady(markPatchRunning(queuePatchTask(createPatchTaskSnapshot())), true, now, null, 1000);
    expect(() => assertCurrentPatchResult(ready, 2, 0)).toThrow(/earlier/);
    const exporting = markPatchExporting(ready, 1, 0);
    expect(markPatchCompleted(exporting, 1, 0).state).toBe("completed");
  });

  it("preserves retryable failure and makes cancellation terminal", () => {
    const failed = markPatchFailure(markPatchRunning(queuePatchTask(createPatchTaskSnapshot())), { code: "ERESOURCE", retryable: true });
    expect(canRetryPatch(failed)).toBe(true);
    expect(markPatchCancelled(failed)).toMatchObject({ state: "cancelled", retryable: false, errorCode: "EABORTED" });
  });
});
