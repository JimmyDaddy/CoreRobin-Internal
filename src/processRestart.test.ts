import { describe, expect, it, vi } from "vitest";

import { getMockSnapshot } from "./mockData";
import {
  waitForProcessIdentityExit,
  waitForProcessReplacement,
} from "./processRestart";
import { processIdentity } from "./utils";

describe("safe application restart", () => {
  it("waits until the exact process identity disappears", async () => {
    const initial = getMockSnapshot();
    const target = initial.processes[0];
    const identity = processIdentity(target);
    const exited = structuredClone(initial);
    exited.processes = exited.processes.filter((process) => processIdentity(process) !== identity);
    const sample = vi.fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(exited);

    await expect(waitForProcessIdentityExit(identity, sample, {
      timeoutMs: 200,
      intervalMs: 50,
      sleep: async () => undefined,
    })).resolves.toBe(true);
    expect(sample).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the target remains or sampling is unavailable", async () => {
    const snapshot = getMockSnapshot();
    const identity = processIdentity(snapshot.processes[0]);

    await expect(waitForProcessIdentityExit(identity, async () => snapshot, {
      timeoutMs: 100,
      intervalMs: 50,
      sleep: async () => undefined,
    })).resolves.toBe(false);
    await expect(waitForProcessIdentityExit(identity, async () => {
      throw new Error("sampler unavailable");
    })).resolves.toBe(false);
  });

  it("verifies that a different identity with the same process name appears", async () => {
    const snapshot = getMockSnapshot();
    const target = snapshot.processes[0];
    const identity = processIdentity(target);
    const replacement = structuredClone(snapshot);
    replacement.processes = replacement.processes.map((process, index) =>
      index === 0
        ? { ...process, pid: process.pid + 10_000, birthToken: "replacement" }
        : process);

    await expect(waitForProcessReplacement(identity, target.name, async () => replacement, {
      timeoutMs: 100,
      intervalMs: 50,
      sleep: async () => undefined,
    })).resolves.toBe(true);
    await expect(waitForProcessReplacement(identity, "missing", async () => replacement, {
      timeoutMs: 100,
      intervalMs: 50,
      sleep: async () => undefined,
    })).resolves.toBe(false);
  });
});
