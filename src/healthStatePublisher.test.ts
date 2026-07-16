import { describe, expect, it } from "vitest";

import type {
  HealthStateSnapshot,
  HealthStateUpdate,
} from "./healthState";
import { HealthStatePublisher } from "./healthStatePublisher";

describe("HealthStatePublisher", () => {
  it("serializes IPC and coalesces queued samples to the newest state", async () => {
    const calls: HealthStateUpdate[] = [];
    const completions: Array<() => void> = [];
    const publisher = new HealthStatePublisher(async (update) => {
      calls.push(update);
      await new Promise<void>((resolve) => completions.push(resolve));
      return { ...update, revision: calls.length };
    });

    publisher.publish(updateAt(1));
    publisher.publish(updateAt(2));
    publisher.publish(updateAt(3));
    await flushPromises();
    expect(calls.map(({ sampledAtMs }) => sampledAtMs)).toEqual([1]);

    completions.shift()?.();
    await flushPromises();
    expect(calls.map(({ sampledAtMs }) => sampledAtMs)).toEqual([1, 3]);

    completions.shift()?.();
    await flushPromises();
    publisher.dispose();
  });

  it("retries only when a later sample wakes a failed publisher", async () => {
    const calls: number[] = [];
    let fail = true;
    const publisher = new HealthStatePublisher(async (update) => {
      calls.push(update.sampledAtMs);
      if (fail) throw new Error("offline");
      return { ...update, revision: calls.length } as HealthStateSnapshot;
    });

    publisher.publish(updateAt(1));
    await flushPromises();
    expect(calls).toEqual([1]);

    fail = false;
    publisher.publish(updateAt(2));
    await flushPromises();
    expect(calls).toEqual([1, 2]);
    publisher.dispose();
  });
});

function updateAt(sampledAtMs: number): HealthStateUpdate {
  return {
    schemaVersion: 2,
    sampledAtMs,
    dataMode: "foreground",
    paused: false,
    health: "normal",
    reason: "none",
    activeCount: 0,
    pendingCount: 0,
    recoveringCount: 0,
    primaryIncident: null,
    cpuPercent: 10,
    memoryPercent: 20,
    storageUsedPercent: 30,
    storageAvailableBytes: 40,
    temperatureCelsius: 50,
    batteryPercent: 60,
    batteryHealthPercent: 94,
    batteryCycleCount: 173,
    batteryState: "discharging",
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
