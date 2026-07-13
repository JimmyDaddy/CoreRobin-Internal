import { describe, expect, it } from "vitest";

import {
  createMockProcessControlLease,
  executeMockProcessAction,
  getMockSnapshot,
  releaseMockProcessControlLease,
} from "./mockData";
import type { CommandError, ProcessAction, ProcessKey } from "./types";

function targetKey(): ProcessKey {
  const target = getMockSnapshot().processes.find(
    (process) => !process.protected && process.birthToken !== null,
  );
  if (!target?.birthToken) throw new Error("mock target is unavailable");
  return { pid: target.pid, birthToken: target.birthToken };
}

function captureCommandError(operation: () => unknown): CommandError {
  try {
    operation();
  } catch (error) {
    return error as CommandError;
  }
  throw new Error("operation unexpectedly succeeded");
}

function createLease(key: ProcessKey, action: ProcessAction = "force_kill") {
  return createMockProcessControlLease({
    key,
    action,
    acknowledgeBestEffort: true,
  });
}

describe("process control lease", () => {
  it("requires explicit acknowledgement for best-effort PID targeting", () => {
    const error = captureCommandError(() =>
      createMockProcessControlLease({
        key: targetKey(),
        action: "force_kill",
        acknowledgeBestEffort: false,
      }),
    );

    expect(error.code).toBe("best_effort_confirmation_required");
  });

  it("is bound to one process identity and action", () => {
    const key = targetKey();
    const lease = createLease(key);
    const error = captureCommandError(() =>
      executeMockProcessAction({
        leaseId: lease.id,
        key,
        action: "request_close",
      }),
    );

    expect(error.code).toBe("control_lease_mismatch");
  });

  it("can be used only once", () => {
    const key = targetKey();
    const lease = createLease(key);
    const result = executeMockProcessAction({
      leaseId: lease.id,
      key,
      action: "force_kill",
    });

    expect(result.signalSent).toBe(true);
    expect(result.outcome).toBe("still_running");
    const error = captureCommandError(() =>
      executeMockProcessAction({
        leaseId: lease.id,
        key,
        action: "force_kill",
      }),
    );
    expect(error.code).toBe("control_lease_unavailable");
  });

  it("cannot execute after cancellation", () => {
    const key = targetKey();
    const lease = createLease(key);
    releaseMockProcessControlLease({ leaseId: lease.id });

    const error = captureCommandError(() =>
      executeMockProcessAction({
        leaseId: lease.id,
        key,
        action: "force_kill",
      }),
    );
    expect(error.code).toBe("control_lease_unavailable");
  });
});
